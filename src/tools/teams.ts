import { z } from "zod";
import { buildPath } from "../inky-client.js";
import { capList, compact, cursorSchema, defineTool, limitSchema, pageInfo, teamIdSchema, type Pagination } from "./common.js";

export interface TeamDetail {
  team_id: string;
  teamid?: string;
  kind: "org" | "team";
  parent_teamid: string | null;
  team_label: string | null;
  disabled: boolean;
  created_at: string;
  domains: string[];
}

interface TeamsListResponse {
  teams: TeamDetail[];
  pagination: Pagination;
}

export function projectTeam(team: TeamDetail, maxDomains = 25): Record<string, unknown> {
  const domains = capList(team.domains, maxDomains);
  return compact({
    team_id: team.team_id,
    kind: team.kind,
    label: team.team_label,
    parent_team_id: team.parent_teamid,
    disabled: team.disabled,
    created_at: team.created_at || null,
    domains: domains.items,
    domains_omitted: domains.omitted || undefined,
  });
}

export const teamsListTool = defineTool({
  name: "inky_teams_list",
  title: "List INKY teams",
  domain: "teams",
  description:
    "List the teams and organization nodes visible to the API key (GET /v1/teams), one page at a time. Each node has kind ('org' groups other nodes, 'team' holds mailboxes), parent_team_id (rebuild the estate tree from it), label and protected domains. Use inky_teams_find to look a customer up by name or domain.",
  inputSchema: {
    cursor: cursorSchema,
    limit: limitSchema(999, 50),
  },
  handler: async (args, ctx) => {
    const res = await ctx.client().get<TeamsListResponse>("/v1/teams", { cursor: args.cursor, limit: args.limit });
    const teams = res.data.teams ?? [];
    return { ...pageInfo(res.data.pagination, teams.length), teams: teams.map((t) => projectTeam(t)) };
  },
});

export const teamsFindTool = defineTool({
  name: "inky_teams_find",
  title: "Find INKY team by name or domain",
  domain: "teams",
  description:
    "Find teams/organization nodes whose label, team id or protected domain contains the query (case-insensitive). Walks GET /v1/teams page by page (up to max_pages pages of 999) and matches client-side, so it answers 'which INKY team is customer X / domain acme.com?'. Returns team_id values to pass to other tools.",
  inputSchema: {
    query: z.string().min(2).max(200).describe("Text to match against team label, team id and protected domains (e.g. 'acme' or 'acme.com')."),
    kind: z.enum(["team", "org"]).optional().describe("Only return nodes of this kind."),
    max_results: z.number().int().min(1).max(200).optional().describe("Maximum matches to return (default 25)."),
    max_pages: z.number().int().min(1).max(20).optional().describe("Maximum pages of 999 nodes to scan (default 10)."),
  },
  handler: async (args, ctx) => {
    const client = ctx.client();
    const needle = args.query.trim().toLowerCase();
    const maxResults = args.max_results ?? 25;
    const maxPages = args.max_pages ?? 10;
    const matches: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    let scanned = 0;
    let pages = 0;
    let complete = false;
    while (pages < maxPages) {
      const res = await client.get<TeamsListResponse>("/v1/teams", { cursor, limit: 999 });
      pages += 1;
      for (const team of res.data.teams ?? []) {
        scanned += 1;
        if (args.kind && team.kind !== args.kind) continue;
        const matchedOn: string[] = [];
        if ((team.team_label ?? "").toLowerCase().includes(needle)) matchedOn.push("label");
        if (team.team_id.toLowerCase().includes(needle)) matchedOn.push("team_id");
        const domainHits = (team.domains ?? []).filter((d) => d.toLowerCase().includes(needle));
        if (domainHits.length > 0) matchedOn.push("domain");
        if (matchedOn.length > 0 && matches.length < maxResults) {
          matches.push({ ...projectTeam(team, 10), matched_on: matchedOn, matching_domains: domainHits.length ? domainHits.slice(0, 10) : undefined });
        }
      }
      const next = res.data.pagination?.next_cursor ?? null;
      if (!next) {
        complete = true;
        break;
      }
      cursor = next;
      if (matches.length >= maxResults) break;
    }
    return {
      query: args.query,
      matches,
      match_count: matches.length,
      nodes_scanned: scanned,
      scan_complete: complete,
      note: complete
        ? undefined
        : "Stopped before the end of the estate (max_results or max_pages reached). Raise max_pages or refine the query for a complete answer.",
    };
  },
});

export const teamsGetTool = defineTool({
  name: "inky_teams_get",
  title: "Get INKY team",
  domain: "teams",
  description: "Get one team or organization node by team_id (GET /v1/teams/{team_id}): kind, label, parent, disabled flag, creation time and every protected domain.",
  inputSchema: { team_id: teamIdSchema },
  handler: async (args, ctx) => {
    const res = await ctx.client().get<TeamDetail>(buildPath`/v1/teams/${["team_id", args.team_id]}`);
    return projectTeam(res.data, 500);
  },
});
