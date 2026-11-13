import { z } from "zod";
import { buildPath } from "../inky-client.js";
import { dateSchema, defineTool, reject, teamIdSchema } from "./common.js";

interface StatisticsResponse {
  team_id: string;
  since: string;
  until: string;
  days: Array<{ date: string; neutral: number; caution: number; danger: number }>;
}

interface ReasonStatisticsResponse {
  team_id: string;
  since: string;
  until: string;
  reasons: Array<{ date: string; reason: string | null; label: string | null; count: number }>;
}

interface ResultCategoryStatisticsResponse {
  team_id: string;
  since: string;
  until: string;
  result_categories: Array<{ date: string; result_category: string | null; count: number }>;
}

function validateWindow(since?: string, until?: string): void {
  if (since && until && since > until) reject("since must not be after until.");
  if (since && until && (Date.parse(until) - Date.parse(since)) / 86_400_000 > 89) reject("The window may span at most 90 days.");
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (until && until >= todayUtc) reject("until must be before today (UTC): today's counts are still partial.");
}

const windowShape = {
  team_id: teamIdSchema.describe("A team id (kind 'team'). Organization nodes are refused by INKY: query each team."),
  since: dateSchema("First UTC day, inclusive (default: 29 days before until; max 90-day window, max 179 days back)"),
  until: dateSchema("Last UTC day, inclusive (default: yesterday; must be before today)"),
};

export function verdictTotals(days: StatisticsResponse["days"]) {
  const totals = { neutral: 0, caution: 0, danger: 0, total: 0 };
  for (const d of days) {
    totals.neutral += d.neutral;
    totals.caution += d.caution;
    totals.danger += d.danger;
  }
  totals.total = totals.neutral + totals.caution + totals.danger;
  return totals;
}

function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 10_000) / 100 : null;
}

export function aggregateReasons(rows: ReasonStatisticsResponse["reasons"]) {
  const map = new Map<string, { reason: string | null; label: string | null; count: number; days: number }>();
  for (const row of rows) {
    const key = row.reason ?? `unmodelled:${row.label ?? "unknown"}`;
    const entry = map.get(key) ?? { reason: row.reason, label: row.label, count: 0, days: 0 };
    entry.count += row.count;
    entry.days += 1;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export const statisticsTool = defineTool({
  name: "inky_statistics_get",
  title: "Get INKY daily statistics",
  domain: "statistics",
  description:
    "One team's daily counts of inbound mail INKY analysed (beta; needs statistics.read), by breakdown: 'verdict' (neutral/caution/danger per day, zeros included), 'reason' (detection codes per day; a message with several reasons counts under each) or 'result_category'. Whole closed UTC days, default the last 30 ending yesterday, max 90 days, max 179 days back. Returns per-day rows plus window totals.",
  inputSchema: {
    ...windowShape,
    breakdown: z.enum(["verdict", "reason", "result_category"]).optional().describe("Which breakdown (default verdict)."),
    reason: z.array(z.string().min(1).max(100)).min(1).max(20).optional().describe("breakdown=reason only: limit rows to these reason codes."),
  },
  handler: async (args, ctx) => {
    validateWindow(args.since, args.until);
    const breakdown = args.breakdown ?? "verdict";
    if (args.reason && breakdown !== "reason") reject("reason filter is only valid with breakdown='reason'.");
    const client = ctx.client();
    const query = { since: args.since, until: args.until };
    if (breakdown === "verdict") {
      const res = await client.get<StatisticsResponse>(buildPath`/beta/teams/${["team_id", args.team_id]}/statistics`, query);
      const totals = verdictTotals(res.data.days ?? []);
      return {
        team_id: res.data.team_id,
        since: res.data.since,
        until: res.data.until,
        breakdown,
        totals: { ...totals, danger_pct: pct(totals.danger, totals.total), caution_pct: pct(totals.caution, totals.total) },
        days: res.data.days ?? [],
      };
    }
    if (breakdown === "reason") {
      const res = await client.get<ReasonStatisticsResponse>(buildPath`/beta/teams/${["team_id", args.team_id]}/statistics/reasons`, {
        ...query,
        reason: args.reason,
      });
      return {
        team_id: res.data.team_id,
        since: res.data.since,
        until: res.data.until,
        breakdown,
        totals_by_reason: aggregateReasons(res.data.reasons ?? []),
        rows: res.data.reasons ?? [],
        note: "Absent means zero. Reason counts do not sum to message counts (a message can carry several reasons).",
      };
    }
    const res = await client.get<ResultCategoryStatisticsResponse>(
      buildPath`/beta/teams/${["team_id", args.team_id]}/statistics/result_categories`,
      query,
    );
    const totals: Record<string, number> = {};
    for (const row of res.data.result_categories ?? []) {
      const key = row.result_category ?? "uncategorised";
      totals[key] = (totals[key] ?? 0) + row.count;
    }
    return {
      team_id: res.data.team_id,
      since: res.data.since,
      until: res.data.until,
      breakdown,
      totals_by_result_category: totals,
      rows: res.data.result_categories ?? [],
    };
  },
});

export const threatSummaryTool = defineTool({
  name: "inky_threat_summary",
  title: "Summarize INKY threats for a team",
  domain: "statistics",
  description:
    "Threat summary for one team over a window of closed UTC days (two beta statistics calls; needs statistics.read): total inbound messages, neutral/caution/danger counts and percentages, the busiest danger days, and the top detection reasons. Good for monthly client reports and spotting a phishing wave; follow up with inky_messages_search (threat_level=danger, or reason=<code>) for the messages behind a spike.",
  inputSchema: {
    ...windowShape,
    top_reasons: z.number().int().min(1).max(50).optional().describe("How many top reasons to return (default 10)."),
    top_days: z.number().int().min(1).max(30).optional().describe("How many peak danger days to return (default 5)."),
  },
  handler: async (args, ctx) => {
    validateWindow(args.since, args.until);
    const client = ctx.client();
    const query = { since: args.since, until: args.until };
    const [verdicts, reasons] = await Promise.all([
      client.get<StatisticsResponse>(buildPath`/beta/teams/${["team_id", args.team_id]}/statistics`, query),
      client.get<ReasonStatisticsResponse>(buildPath`/beta/teams/${["team_id", args.team_id]}/statistics/reasons`, query),
    ]);
    const days = verdicts.data.days ?? [];
    const totals = verdictTotals(days);
    const peakDays = [...days]
      .filter((d) => d.danger > 0)
      .sort((a, b) => b.danger - a.danger)
      .slice(0, args.top_days ?? 5)
      .map((d) => ({ date: d.date, danger: d.danger, caution: d.caution, total: d.neutral + d.caution + d.danger }));
    const dayCount = days.length || 1;
    return {
      team_id: verdicts.data.team_id,
      since: verdicts.data.since,
      until: verdicts.data.until,
      days_in_window: days.length,
      inbound_messages: totals.total,
      verdicts: {
        neutral: totals.neutral,
        caution: totals.caution,
        danger: totals.danger,
        caution_pct: pct(totals.caution, totals.total),
        danger_pct: pct(totals.danger, totals.total),
      },
      daily_average: {
        messages: Math.round((totals.total / dayCount) * 10) / 10,
        danger: Math.round((totals.danger / dayCount) * 10) / 10,
      },
      peak_danger_days: peakDays,
      top_reasons: aggregateReasons(reasons.data.reasons ?? []).slice(0, args.top_reasons ?? 10),
      follow_up:
        "To see the messages behind a peak day or reason, call inky_messages_search with team_id, since/until for that day and threat_level=danger or reason=[code].",
    };
  },
});
