import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { fixedCredentialResolver, type InkyCredentials } from "../src/credentials.js";
import { createMcpServer } from "../src/server.js";

export const TEST_KEY = "inky_ext_TESTKEY000000000000000000000000abc123";

export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  redirect?: RequestInit["redirect"];
}

export type Route = (url: URL, req: RecordedRequest) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function inkyError(status: number, code: string, message = code, headers: Record<string, string> = {}, details?: unknown): Response {
  return json({ error: { code, message, ...(details ? { details } : {}) } }, status, { "x-request-id": `req-${code}`, ...headers });
}

/** A fetch stand-in that records requests and answers from a route function. */
export function mockFetch(route: Route) {
  const requests: RecordedRequest[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const req: RecordedRequest = { url, method: init?.method ?? "GET", headers, redirect: init?.redirect };
    requests.push(req);
    return route(url, req);
  }) as typeof fetch;
  return { fetch: fn, requests };
}

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { ...loadConfig({}), maxRetryWaitSeconds: 30, ...overrides };
}

export const EU_CREDS: InkyCredentials = { apiKey: TEST_KEY, baseUrl: "https://api.eu.inkyphishfence.com", region: "eu" };

/** Connect an in-memory MCP client to a server backed by the mock fetch. */
export async function connectClient(route: Route, opts: { config?: Partial<ServerConfig>; creds?: InkyCredentials } = {}) {
  const mock = mockFetch(route);
  const sleeps: number[] = [];
  const server = createMcpServer({
    config: testConfig(opts.config),
    resolveCredentials: fixedCredentialResolver(opts.creds ?? EU_CREDS),
    clientDeps: { fetch: mock.fetch, sleep: async (ms) => void sleeps.push(ms) },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { isError: Boolean(result.isError), text, json: parsed as Record<string, unknown> };
  };
  return { client, call, requests: mock.requests, sleeps, close: () => client.close() };
}
