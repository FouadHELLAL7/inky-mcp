/**
 * Streamable HTTP transport (stateless), mirroring the WYRE-AI reference servers:
 *
 * - POST /mcp: one fresh MCP server + transport per request
 *   (sessionIdGenerator: undefined, enableJsonResponse: true). Statelessness is
 *   a tenant-isolation invariant: credentials are bound to the per-request
 *   server, so a long-lived session can never serve a later caller.
 * - GET /health and /healthz: unauthenticated liveness; never reads credentials
 *   and exposes no tenant or secret data.
 * - Startup fails closed without a real CONDUIT_S2S_SECRET unless
 *   MCP_ALLOW_INSECURE_DEV=1 (then loopback bind only). Every /mcp request must
 *   carry a valid X-Gateway-S2S header when a secret is configured.
 * - AUTH_MODE=gateway: X-Inky-Api-Key (+ optional X-Inky-Region) per request,
 *   no fallback to INKY_API_KEY from the environment.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ServerConfig } from "./config.js";
import { envCredentialResolver, fixedCredentialResolver, gatewayCredentialsFromHeaders, type CredentialResolver } from "./credentials.js";
import type { ClientDeps } from "./inky-client.js";
import { logger } from "./logger.js";
import { S2S_HEADER, verifyS2sHeader } from "./s2s-verify.js";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

/** Public example values. A copied placeholder must never verify as a real secret. */
export const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const LOOPBACK_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 1024 * 1024;

export class StartupError extends Error {}

export interface HttpOptions {
  config: ServerConfig;
  env?: NodeJS.ProcessEnv;
  clientDeps?: ClientDeps;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") return true;
  const bare = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  const parts = bare.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255) && parts[0] === "127";
}

export function resolveS2sSecret(env: NodeJS.ProcessEnv): { secret: string; insecureDev: boolean } {
  const raw = (env.CONDUIT_S2S_SECRET ?? "").trim();
  if (raw && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    throw new StartupError(
      "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. Generate one with `openssl rand -hex 32`.",
    );
  }
  if (raw) return { secret: raw, insecureDev: false };
  if (env.MCP_ALLOW_INSECURE_DEV === "1") return { secret: "", insecureDev: true };
  throw new StartupError(
    "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. Set it to the gateway-provisioned secret, or set MCP_ALLOW_INSECURE_DEV=1 for local development only.",
  );
}

export function resolveBindHost(insecureDev: boolean, env: NodeJS.ProcessEnv): string {
  const configured = (env.MCP_HTTP_HOST ?? "").trim();
  if (!insecureDev) return configured || LOOPBACK_HOST;
  if (configured === "" || isLoopbackHost(configured)) return LOOPBACK_HOST;
  throw new StartupError(
    `Refusing to start HTTP transport: MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET only listens on ${LOOPBACK_HOST}; MCP_HTTP_HOST=${configured} is not loopback.`,
  );
}

export function resolvePort(env: NodeJS.ProcessEnv): number {
  const raw = env.MCP_HTTP_PORT ?? env.PORT ?? "8080";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new StartupError(`Invalid MCP_HTTP_PORT/PORT: ${raw}`);
  return port;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new SyntaxError("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export async function startHttpServer(options: HttpOptions): Promise<HttpServer> {
  const env = options.env ?? process.env;
  const { config, clientDeps } = options;
  const { secret, insecureDev } = resolveS2sSecret(env);
  const host = resolveBindHost(insecureDev, env);
  const port = resolvePort(env);
  const gatewayMode = (env.AUTH_MODE ?? "env").trim().toLowerCase() === "gateway";
  if (insecureDev) {
    logger.error("SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. /mcp does not check X-Gateway-S2S and listens on 127.0.0.1 only. Local development only.");
  }
  const envResolver: CredentialResolver = envCredentialResolver(config, env);

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");

    if (url.pathname === "/health" || url.pathname === "/healthz") {
      sendJson(res, 200, {
        status: "ok",
        server: SERVER_NAME,
        version: SERVER_VERSION,
        transport: "http",
        authMode: gatewayMode ? "gateway" : "env",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "Not found", endpoints: ["/mcp", "/health", "/healthz"] });
      return;
    }

    // S2S is enforced before anything else, including credential extraction.
    if (secret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), secret)) {
      sendJson(res, 401, { error: "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway." });
      return;
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this stateless server accepts POST /mcp only." }, id: null });
      return;
    }

    let resolver: CredentialResolver = envResolver;
    if (gatewayMode) {
      const result = gatewayCredentialsFromHeaders(req.headers, config);
      if (!result.ok) {
        sendJson(res, result.status, result.body);
        return;
      }
      resolver = fixedCredentialResolver(result.credentials);
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      const tooLarge = (error as Error).message === "Request body too large";
      sendJson(res, tooLarge ? 413 : 400, { jsonrpc: "2.0", error: { code: -32700, message: tooLarge ? "Request body too large" : "Parse error" }, id: null });
      return;
    }

    const server = createMcpServer({ config, resolveCredentials: resolver, clientDeps });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      logger.error("MCP transport error", { error: (error as Error).message });
      sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  logger.info(`INKY MCP server listening on http://${host}:${boundPort}/mcp (auth mode: ${gatewayMode ? "gateway" : "env"}, region default: ${config.defaultRegion})`);
  return httpServer;
}
