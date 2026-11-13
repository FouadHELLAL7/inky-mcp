import { z } from "zod";
import { defineTool } from "./common.js";

interface MeResponse {
  teamid: string;
  key_prefix: string;
  key_name?: string | null;
  key_type: string;
  scope_type: "org" | "team";
  permissions: Record<string, string[]>;
  expires_at?: string | null;
  status: "active" | "rotated";
  rotated_at?: string | null;
  grace_expires_at?: string | null;
}

/** Map permission namespaces to the tools that need them, so the model knows what will work. */
const PERMISSION_TOOLS: Record<string, string[]> = {
  messages: ["inky_messages_search"],
  statistics: ["inky_statistics_get", "inky_threat_summary"],
  reported_mail: ["inky_reported_mail_list", "inky_reported_mail_get", "inky_reported_mail_item_actions (needs remediate)"],
  allow_list: ["inky_allow_list_list", "inky_allow_list_get"],
  block_list: ["inky_block_list_list", "inky_block_list_get"],
  vips: ["inky_vips_list", "inky_vips_get"],
  admins: ["inky_admins_list", "inky_admins_get"],
};

export const statusTool = defineTool({
  name: "inky_status",
  title: "INKY server status",
  domain: "account",
  description:
    "Show this MCP server's INKY configuration (region, API origin, whether a key is configured) and check that the INKY API is reachable via the unauthenticated GET /v1/status. Does not validate the key; use inky_test_connection for that.",
  inputSchema: {},
  handler: async (_args, ctx) => {
    const client = ctx.client();
    let apiStatus: unknown;
    try {
      apiStatus = (await client.get<{ status: string }>("/v1/status", undefined, { authenticated: false })).data;
    } catch (error) {
      apiStatus = { reachable: false, error: (error as Error).message };
    }
    return {
      server: "inky-mcp",
      region: client.region,
      api_base_url: client.baseUrl,
      api_key_configured: client.hasApiKey,
      raw_request_enabled: ctx.config.rawRequestEnabled,
      write_tools: "none (read-only server)",
      inky_api_status: apiStatus,
      next_step: "Call inky_test_connection to validate the API key and see its scope and permissions.",
    };
  },
});

export const testConnectionTool = defineTool({
  name: "inky_test_connection",
  title: "Validate INKY API key",
  domain: "account",
  description:
    "Validate the INKY API key (GET /v1/me) and report its scope root (team or organization), permissions, lifecycle (active/rotated, expiry) and current rate-limit headers. Run this first when a tool returns FORBIDDEN or authentication errors.",
  inputSchema: {},
  handler: async (_args, ctx) => {
    const client = ctx.client();
    const res = await client.get<MeResponse>("/v1/me");
    const me = res.data;
    const namespaces = Object.keys(me.permissions ?? {});
    const usableTools = ["inky_teams_list", "inky_teams_find", "inky_teams_get", "inky_usage_get", "inky_usage_history"];
    for (const ns of namespaces) {
      const ops = me.permissions[ns] ?? [];
      if (ops.includes("read") && PERMISSION_TOOLS[ns]) usableTools.push(...PERMISSION_TOOLS[ns]);
    }
    const warnings: string[] = [];
    if (me.status === "rotated") warnings.push(`Key was rotated and stops working at ${me.grace_expires_at}. Deploy the replacement key.`);
    if (res.keyExpiresSoon) warnings.push(`Key expires soon (${res.keyExpiresAt}). Rotate it in the INKY console.`);
    return {
      ok: true,
      region: client.region,
      api_base_url: client.baseUrl,
      key: {
        prefix: me.key_prefix,
        name: me.key_name ?? null,
        type: me.key_type,
        status: me.status,
        expires_at: me.expires_at ?? null,
        rotated_at: me.rotated_at ?? null,
        grace_expires_at: me.grace_expires_at ?? null,
      },
      scope: { root_team_id: me.teamid, scope_type: me.scope_type },
      permissions: me.permissions,
      tools_this_key_can_use: usableTools,
      warnings,
      rate_limit: res.rateLimit ?? null,
      request_id: res.requestId ?? null,
    };
  },
});

export function navigateTool(listing: () => Record<string, Array<{ name: string; title: string }>>) {
  return defineTool({
    name: "inky_navigate",
    title: "Discover INKY tools",
    domain: "account",
    description:
      "List the INKY tools by domain with one-line titles. A help/discovery aid: every tool is always callable. Typical investigation flow: inky_teams_find → inky_messages_search → inky_reported_mail_list / inky_allow_list_list → inky_threat_summary.",
    inputSchema: {
      domain: z
        .enum(["account", "teams", "usage", "messages", "statistics", "reported_mail", "allow_block", "vips", "admins", "reference", "raw"])
        .optional()
        .describe("Only list this domain."),
    },
    handler: async (args) => {
      const all = listing();
      return args.domain ? { [args.domain]: all[args.domain] ?? [] } : all;
    },
  });
}
