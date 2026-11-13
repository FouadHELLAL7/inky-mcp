import { z } from "zod";
import { cursorSchema, dateSchema, defineTool, limitSchema, pageInfo, reject, type Pagination } from "./common.js";

interface UsageResponse {
  data_as_of: string;
  is_trial?: boolean;
  trial_end?: string | null;
  pagination: Pagination;
  summary: { total_billable_mailboxes: number };
  teams: Array<{ team_id: string; team_name: string; billable_mailbox_count: number; product_skus: string[] }>;
}

interface UsageHistoryResponse {
  date_range: { start: string | null; end: string | null; days: number };
  is_trial?: boolean;
  trial_end?: string | null;
  pagination: Pagination;
  daily_totals: Array<{ date: string; billable_mailbox_count: number }>;
  teams: Array<{ team_id: string; team_name: string; daily: Array<{ date: string; billable_mailbox_count: number }> }>;
}

export const usageGetTool = defineTool({
  name: "inky_usage_get",
  title: "Get INKY billable usage",
  domain: "usage",
  description:
    "Current billable mailbox usage snapshot per team (GET /v1/usage). total_billable_mailboxes covers the whole estate on every page; teams are paged. Useful for license reconciliation and spotting teams with zero protected mailboxes.",
  inputSchema: { cursor: cursorSchema, limit: limitSchema(999, 50) },
  handler: async (args, ctx) => {
    const res = await ctx.client().get<UsageResponse>("/v1/usage", { cursor: args.cursor, limit: args.limit });
    const d = res.data;
    return {
      data_as_of: d.data_as_of || null,
      is_trial: d.is_trial ?? null,
      trial_end: d.trial_end ?? null,
      total_billable_mailboxes_all_teams: d.summary?.total_billable_mailboxes ?? null,
      ...pageInfo(d.pagination, d.teams?.length ?? 0),
      teams: d.teams ?? [],
      note: "total_billable_mailboxes_all_teams is estate-wide on every page; do not add it up across pages.",
    };
  },
});

export const usageHistoryTool = defineTool({
  name: "inky_usage_history",
  title: "Get INKY usage history",
  domain: "usage",
  description:
    "Daily billable mailbox counts per team plus an estate-wide daily series (GET /v1/usage/history). Use days (1-90, default 30) OR start_date+end_date (inclusive, max 365 days), not both. daily_totals is complete on every page: take it from the first page only.",
  inputSchema: {
    days: z.number().int().min(1).max(90).optional().describe("Number of most recent snapshot days (1-90). Mutually exclusive with start_date/end_date."),
    start_date: dateSchema("Inclusive start date; requires end_date"),
    end_date: dateSchema("Inclusive end date; requires start_date; range max 365 days"),
    cursor: cursorSchema,
    limit: limitSchema(999, 50),
  },
  handler: async (args, ctx) => {
    if (args.days !== undefined && (args.start_date || args.end_date)) reject("Use either days or start_date/end_date, not both.");
    if (Boolean(args.start_date) !== Boolean(args.end_date)) reject("start_date and end_date must be given together.");
    if (args.start_date && args.end_date) {
      const span = (Date.parse(args.end_date) - Date.parse(args.start_date)) / 86_400_000;
      if (span < 0) reject("start_date must not be after end_date.");
      if (span > 365) reject("The date range may not exceed 365 days.");
    }
    const res = await ctx.client().get<UsageHistoryResponse>("/v1/usage/history", {
      days: args.days,
      start_date: args.start_date,
      end_date: args.end_date,
      cursor: args.cursor,
      limit: args.limit,
    });
    const d = res.data;
    return {
      date_range: d.date_range,
      is_trial: d.is_trial ?? null,
      daily_totals_all_teams: d.daily_totals ?? [],
      ...pageInfo(d.pagination, d.teams?.length ?? 0),
      teams: d.teams ?? [],
      note: "daily_totals_all_teams is complete on every page; never concatenate it across pages. Days without a snapshot are omitted.",
    };
  },
});
