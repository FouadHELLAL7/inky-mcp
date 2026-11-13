#!/usr/bin/env node
/**
 * INKY MCP server entry point.
 *
 * MCP_TRANSPORT=stdio (default): single caller, credentials from INKY_API_KEY.
 * MCP_TRANSPORT=http: Streamable HTTP on MCP_HTTP_PORT (default 8080) with
 * /mcp and /health; AUTH_MODE=gateway reads X-Inky-* headers per request.
 *
 * All logs go to stderr so stdout carries only JSON-RPC in stdio mode.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { envCredentialResolver } from "./credentials.js";
import { startHttpServer, StartupError } from "./http.js";
import { logger } from "./logger.js";
import { createMcpServer } from "./server.js";

export { createMcpServer } from "./server.js";
export { startHttpServer } from "./http.js";
export { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const transport = (process.env.MCP_TRANSPORT ?? "stdio").trim().toLowerCase();

  if (transport === "http") {
    const httpServer = await startHttpServer({ config });
    const shutdown = () => {
      logger.info("Shutting down INKY MCP server");
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }
  if (transport !== "stdio") throw new ConfigError(`MCP_TRANSPORT must be "stdio" or "http" (got "${transport}").`);

  const server = createMcpServer({ config, resolveCredentials: envCredentialResolver(config) });
  await server.connect(new StdioServerTransport());
  logger.info(`INKY MCP server running on stdio (region default: ${config.defaultRegion}, API key ${process.env.INKY_API_KEY ? "configured" : "NOT configured"})`);
}

if (process.env.VITEST !== "true") {
  main().catch((error: unknown) => {
    const known = error instanceof ConfigError || error instanceof StartupError;
    logger.error(known ? (error as Error).message : "Fatal startup error", known ? undefined : { error });
    process.exit(1);
  });
}
