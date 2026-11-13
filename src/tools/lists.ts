import { z } from "zod";
import { buildPath } from "../inky-client.js";
import { compact, cursorSchema, defineTool, emailSchema, limitSchema, opaqueIdSchema, pageInfo, reject, teamIdSchema, type Pagination } from "./common.js";

type Entry = Record<string, unknown>;

const optionalTeam = z
  .string()
  .min(1)
  .max(256)
  .optional()
  .describe("Team or organization node. Omit for an estate-wide sweep (each rule listed once, on the node it is set on, without inheritance).");

const inheritedSchema = z
  .boolean()
  .optional()
  .describe("Per-team only. true (INKY default): own rules plus blanket rules inherited from ancestors — the 'why was this allowed/blocked' view. false: only rules set directly on this team.");

function checkInherited(teamId: string | undefined, inherited: boolean | undefined): void {
  if (inherited !== undefined && !teamId) reject("inherited is only valid together with team_id.");
}

function entriesResult(scope: string, key: string, rows: Entry[] | undefined, pagination: Pagination | undefined) {
  const list = rows ?? [];
  return { scope, ...pageInfo(pagination, list.length), [key]: list.map((e) => compact(e)) };
}

export const allowListListTool = defineTool({
  name: "inky_allow_list_list",
  title: "List INKY allow-list rules",
  domain: "allow_block",
  description:
    "List allow-list rules, which suppress an INKY verdict (result_type) for matching mail (beta; needs allow_list.read). Estate-wide, or for one node with team_id (includes inherited blanket rules unless inherited=false). Filters: sender, domain, result_type ('*' = allow-anything rules, the usual audit target), user_email, enabled. Each rule has a shape (sender, domain, url, attachment, …) naming its criteria fields. Use to answer 'why was this phish delivered?'.",
  inputSchema: {
    team_id: optionalTeam,
    inherited: inheritedSchema,
    sender: z.string().min(1).max(320).optional().describe("Sender email or domain of sender-shaped rules (exact, case-insensitive)."),
    domain: z.string().min(1).max(253).optional().describe("Domain of domain-shaped rules (exact)."),
    result_type: z.string().min(1).max(100).optional().describe("Verdict code, e.g. spam_content, graymail, brand_impersonation, or '*'. See inky_result_types_list."),
    user_email: emailSchema("Only rules scoped to this mailbox (team-wide rules excluded)."),
    enabled: z.boolean().optional().describe("true: active rules only; false: disabled rules only."),
    cursor: cursorSchema,
    limit: limitSchema(999, 50),
  },
  handler: async (args, ctx) => {
    checkInherited(args.team_id, args.inherited);
    const path = args.team_id ? buildPath`/beta/teams/${["team_id", args.team_id]}/allow_list` : "/beta/allow_list";
    const res = await ctx.client().get<{ allow_list: Entry[]; pagination: Pagination }>(path, {
      inherited: args.inherited,
      sender: args.sender,
      domain: args.domain,
      result_type: args.result_type,
      user_email: args.user_email,
      enabled: args.enabled,
      cursor: args.cursor,
      limit: args.limit,
    });
    return entriesResult(args.team_id ?? "estate", "allow_list", res.data.allow_list, res.data.pagination);
  },
});

export const allowListGetTool = defineTool({
  name: "inky_allow_list_get",
  title: "Get INKY allow-list rule",
  domain: "allow_block",
  description: "Get one allow-list rule on a team by its id (beta; needs allow_list.read).",
  inputSchema: { team_id: teamIdSchema, entry_id: opaqueIdSchema("Allow-list entry id") },
  handler: async (args, ctx) => {
    const res = await ctx.client().get<Entry>(buildPath`/beta/teams/${["team_id", args.team_id]}/allow_list/${["entry_id", args.entry_id]}`);
    return compact(res.data);
  },
});

export const blockListListTool = defineTool({
  name: "inky_block_list_list",
  title: "List INKY block-list rules",
  domain: "allow_block",
  description:
    "List block-list rules, which force a verdict for mail from matching senders (beta; needs block_list.read). Estate-wide, or for one node with team_id (includes inherited blanket rules unless inherited=false). Filters: from_email, from_domain (domain rules also cover subdomains), sender_ip, user_email, result_type, enabled.",
  inputSchema: {
    team_id: optionalTeam,
    inherited: inheritedSchema,
    from_email: emailSchema("Sender email of the rule (exact, case-insensitive)."),
    from_domain: z.string().min(1).max(253).optional().describe("Sender domain of the rule (exact)."),
    sender_ip: z.string().min(2).max(64).optional().describe("Sending IP of the rule (exact)."),
    user_email: emailSchema("Only rules scoped to this mailbox (team-wide rules excluded)."),
    result_type: z
      .enum(["blocked_sender", "spam_content", "graymail", "phishing_content", "potential_sender_risk"])
      .optional()
      .describe("Verdict the rule forces."),
    enabled: z.boolean().optional().describe("true: active rules only; false: disabled rules only."),
    cursor: cursorSchema,
    limit: limitSchema(999, 50),
  },
  handler: async (args, ctx) => {
    checkInherited(args.team_id, args.inherited);
    const path = args.team_id ? buildPath`/beta/teams/${["team_id", args.team_id]}/block_list` : "/beta/block_list";
    const res = await ctx.client().get<{ block_list: Entry[]; pagination: Pagination }>(path, {
      inherited: args.inherited,
      from_email: args.from_email,
      from_domain: args.from_domain,
      sender_ip: args.sender_ip,
      user_email: args.user_email,
      result_type: args.result_type,
      enabled: args.enabled,
      cursor: args.cursor,
      limit: args.limit,
    });
    return entriesResult(args.team_id ?? "estate", "block_list", res.data.block_list, res.data.pagination);
  },
});

export const blockListGetTool = defineTool({
  name: "inky_block_list_get",
  title: "Get INKY block-list rule",
  domain: "allow_block",
  description: "Get one block-list rule on a team by its id (beta; needs block_list.read).",
  inputSchema: { team_id: teamIdSchema, entry_id: opaqueIdSchema("Block-list entry id") },
  handler: async (args, ctx) => {
    const res = await ctx.client().get<Entry>(buildPath`/beta/teams/${["team_id", args.team_id]}/block_list/${["entry_id", args.entry_id]}`);
    return compact(res.data);
  },
});

export const vipsListTool = defineTool({
  name: "inky_vips_list",
  title: "List INKY VIPs",
  domain: "vips",
  description:
    "List VIP entries — protected display names (first name, last name, expected email) INKY uses to detect name spoofing (beta; needs vips.read). Estate-wide or per team; VIPs are strictly per-team and never inherited. Filters: email (exact), first_name / last_name (case-insensitive prefix).",
  inputSchema: {
    team_id: z.string().min(1).max(256).optional().describe("A team id. Omit for every team in scope."),
    email: emailSchema("Exact VIP email (case-insensitive)."),
    first_name: z.string().min(1).max(200).optional().describe("First-name prefix."),
    last_name: z.string().min(1).max(200).optional().describe("Last-name prefix."),
    cursor: cursorSchema,
    limit: limitSchema(999, 50),
  },
  handler: async (args, ctx) => {
    const path = args.team_id ? buildPath`/beta/teams/${["team_id", args.team_id]}/vips` : "/beta/vips";
    const res = await ctx.client().get<{ vips: Entry[]; pagination: Pagination }>(path, {
      email: args.email,
      first_name: args.first_name,
      last_name: args.last_name,
      cursor: args.cursor,
      limit: args.limit,
    });
    return entriesResult(args.team_id ?? "estate", "vips", res.data.vips, res.data.pagination);
  },
});

export const vipsGetTool = defineTool({
  name: "inky_vips_get",
  title: "Get INKY VIP",
  domain: "vips",
  description: "Get one VIP entry on a team by its id (beta; needs vips.read).",
  inputSchema: { team_id: teamIdSchema, entry_id: opaqueIdSchema("VIP entry id") },
  handler: async (args, ctx) => {
    const res = await ctx.client().get<Entry>(buildPath`/beta/teams/${["team_id", args.team_id]}/vips/${["entry_id", args.entry_id]}`);
    return compact(res.data);
  },
});

export const adminsListTool = defineTool({
  name: "inky_admins_list",
  title: "List INKY console admins",
  domain: "admins",
  description:
    "Audit who holds INKY console roles (beta; needs admins.read). Without team_id: every principal across the estate with its DIRECT grants (filter by email). With team_id: who effectively administers that team, including grants inherited from ancestors (inherited=false for direct only); access is the union of all scope_grants. Principals are people (email), IdP groups or Kaseya One roles.",
  inputSchema: {
    team_id: z.string().min(1).max(256).optional().describe("Team or organization node; omit for the estate-wide list."),
    email: emailSchema("Estate-wide only: grants held by this email principal."),
    inherited: z.boolean().optional().describe("Per-team only: include inherited grants (INKY default true)."),
    cursor: cursorSchema,
    limit: limitSchema(999, 50),
  },
  handler: async (args, ctx) => {
    if (args.email && args.team_id) reject("email filter is only available on the estate-wide list; use inky_admins_get for one admin on a team.");
    checkInherited(args.team_id, args.inherited);
    const path = args.team_id ? buildPath`/beta/teams/${["team_id", args.team_id]}/admins` : "/beta/admins";
    const res = await ctx.client().get<{ admins: Entry[]; pagination: Pagination }>(path, {
      email: args.email,
      inherited: args.inherited,
      cursor: args.cursor,
      limit: args.limit,
    });
    return entriesResult(args.team_id ?? "estate", "admins", res.data.admins, res.data.pagination);
  },
});

export const adminsGetTool = defineTool({
  name: "inky_admins_get",
  title: "Get INKY admin on a team",
  domain: "admins",
  description: "Get one email principal's effective console grant on a team (beta; needs admins.read). 404 when the email has no grant visible at that team.",
  inputSchema: {
    team_id: teamIdSchema,
    email: z.string().min(3).max(320).describe("Admin email address."),
    inherited: z.boolean().optional().describe("Include grants inherited from ancestors (INKY default true)."),
  },
  handler: async (args, ctx) => {
    const res = await ctx.client().get<Entry>(buildPath`/beta/teams/${["team_id", args.team_id]}/admins/${["email", args.email]}`, {
      inherited: args.inherited,
    });
    return res.data;
  },
});

export const resultTypesTool = defineTool({
  name: "inky_result_types_list",
  title: "List INKY verdict types",
  domain: "reference",
  description:
    "The catalog of verdict codes (result_type) used by allow and block lists, with the console label, a description, which lists support it and its rule shape (beta). Use it to translate between what an admin saw in the console and the codes the API uses.",
  inputSchema: {
    list: z.enum(["allow", "block"]).optional().describe("Only verdicts modelled on this list."),
  },
  handler: async (args, ctx) => {
    const res = await ctx.client().get<{ result_types: Array<Entry & { lists?: string[] }> }>("/beta/result_types");
    const all = res.data.result_types ?? [];
    const filtered = args.list ? all.filter((r) => (r.lists ?? []).includes(args.list as string)) : all;
    return { count: filtered.length, result_types: filtered.map((r) => compact(r)) };
  },
});
