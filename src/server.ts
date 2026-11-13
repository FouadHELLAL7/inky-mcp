/**
 * Side-effect-free MCP server factory. Each server instance is bound to one
 * credential resolver; in gateway mode a fresh instance is created for every
 * HTTP request, so callers never share credentials.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "./config.js";
import type { CredentialResolver } from "./credentials.js";
import { formatToolError, InkyApiError } from "./errors.js";
import { InkyClient, type ClientDeps } from "./inky-client.js";
import { logger } from "./logger.js";
import { fitToBudget, type ToolContext } from "./tools/common.js";
import { getTools } from "./tools/index.js";

export const SERVER_NAME = "inky-mcp";
export const SERVER_VERSION = "1.0.0";

export interface CreateServerOptions {
  config: ServerConfig;
  resolveCredentials: CredentialResolver;
  /** Test hook: inject fetch/sleep into the INKY client. */
  clientDeps?: ClientDeps;
}

const INSTRUCTIONS =
  "Read-only tools for the INKY email security External API. Start with inky_test_connection to see the key's scope and permissions, " +
  "use inky_teams_find to resolve a customer to a team_id, then inky_messages_search, inky_reported_mail_list, inky_allow_list_list / inky_block_list_list " +
  "and inky_threat_summary. Most families are INKY beta endpoints. Message bodies are never available; results are bounded and paged with next_cursor.";

export function createMcpServer(options: CreateServerOptions): McpServer {
  const { config, resolveCredentials, clientDeps } = options;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS, capabilities: { logging: {} } });

  const ctx: ToolContext = {
    config,
    client: () => new InkyClient(resolveCredentials(), config, clientDeps),
  };

  for (const tool of getTools({ rawRequestEnabled: config.rawRequestEnabled })) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: tool.name !== "inky_navigate",
        },
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const started = Date.now();
        try {
          const result = await tool.handler(args, ctx);
          logger.debug("Tool call ok", { tool: tool.name, ms: Date.now() - started });
          return { content: [{ type: "text", text: fitToBudget(result, config.maxOutputChars) }] };
        } catch (error) {
          const code = error instanceof InkyApiError ? error.code : (error as Error)?.name;
          logger.warn("Tool call failed", { tool: tool.name, code, ms: Date.now() - started });
          return { content: [{ type: "text", text: formatToolError(error) }], isError: true };
        }
      },
    );
  }

  return server;
}
