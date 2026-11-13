import { z } from "zod";
import { buildPath } from "../inky-client.js";
import {
  capList,
  clip,
  compact,
  cursorSchema,
  dateTimeSchema,
  defineTool,
  limitSchema,
  opaqueIdSchema,
  pageInfo,
  reject,
  type Pagination,
} from "./common.js";

interface UserReport {
  id: number;
  label?: string | null;
  status?: string | null;
  contact_email?: string | null;
  comment?: string | null;
  reported_at?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
}

interface ReportedMailItem {
  id: string;
  source_id?: string | null;
  source_type?: string | null;
  rfc822_message_id?: string | null;
  sender?: string | null;
  direction?: string | null;
  status: string;
  comment?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  reports?: UserReport[];
}

interface ReportedMailRecord {
  id: string;
  team_id: string;
  title?: string | null;
  record_type?: string | null;
  status: string;
  resolution?: string | null;
  priority: string;
  severity: string;
  assigned_to?: string | null;
  resolution_summary?: string | null;
  details?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  resolved_at?: string | null;
  closed_at?: string | null;
  external_ticket?: { system: string; ticket_id: string; ticket_number?: string | null; url?: string | null } | null;
  queue_route?: string | null;
  item_count?: number;
  items?: ReportedMailItem[];
}

interface ReportedMailListResponse {
  records: ReportedMailRecord[];
  pagination: Pagination;
  poll_from: string;
}

function projectItem(item: ReportedMailItem): Record<string, unknown> {
  return compact({
    item_id: item.id,
    status: item.status,
    sender: item.sender,
    rfc822_message_id: item.rfc822_message_id,
    source_type: item.source_type,
    direction: item.direction,
    comment: clip(item.comment, 300),
    created_at: item.created_at,
    updated_at: item.updated_at,
    reports: (item.reports ?? []).map((r) =>
      compact({
        report_id: r.id,
        reporter_label: r.label,
        status: r.status,
        reporter: r.contact_email,
        comment: clip(r.comment, 300),
        reported_at: r.reported_at,
        reviewed_by: r.reviewed_by,
        reviewed_at: r.reviewed_at,
      }),
    ),
  });
}

export function projectRecord(record: ReportedMailRecord, maxItems: number): Record<string, unknown> {
  const items = capList(record.items, maxItems);
  const total = record.item_count ?? record.items?.length ?? 0;
  return compact({
    record_id: record.id,
    team_id: record.team_id,
    title: clip(record.title, 300),
    status: record.status,
    severity: record.severity,
    priority: record.priority,
    queue_route: record.queue_route,
    record_type: record.record_type,
    resolution: record.resolution,
    resolution_summary: clip(record.resolution_summary, 500),
    details: clip(record.details, 1000),
    assigned_to: record.assigned_to,
    created_at: record.created_at,
    updated_at: record.updated_at,
    resolved_at: record.resolved_at,
    closed_at: record.closed_at,
    external_ticket: record.external_ticket ?? undefined,
    item_count: total,
    items: items.items.map(projectItem),
    items_omitted: total > items.items.length ? total - items.items.length : undefined,
  });
}

export const reportedMailListTool = defineTool({
  name: "inky_reported_mail_list",
  title: "List INKY reported mail",
  domain: "reported_mail",
  description:
    "List the reported-mail triage queue: records built from user-reported messages with at least one open item (beta; needs reported_mail.read). Estate-wide, or one node with team_id. Default window is the last 7 days of activity; created_since/created_until reach older records. updated_since or rfc822_message_id also return already-closed records ('what happened to this message?'). Each record shows severity, queue_route (triage bucket), items with sender/Message-ID and the user reports. Keep poll_from and pass it as updated_since next time; re-reading the same first page within 60 s is refused with POLLED_TOO_SOON.",
  inputSchema: {
    team_id: z.string().min(1).max(256).optional().describe("Limit to this team/organization node. Omit for the whole estate."),
    severity: z.enum(["informational", "low", "medium", "high", "critical"]).optional().describe("Only records with this severity."),
    search: z.string().min(1).max(200).optional().describe("Case-insensitive substring match on the record title."),
    created_since: dateTimeSchema("Only records created at or after this time (replaces the 7-day default window)"),
    created_until: dateTimeSchema("Only records created at or before this time (replaces the 7-day default window)"),
    updated_since: dateTimeSchema("Only records changed at or after this time; includes closed records. Use the previous poll_from"),
    rfc822_message_id: z.string().min(1).max(998).optional().describe("Records containing this Message-ID (angle brackets optional); includes closed records."),
    sender: z.string().min(3).max(320).optional().describe("Refines rfc822_message_id to this sender. Requires rfc822_message_id."),
    max_items_per_record: z.number().int().min(1).max(50).optional().describe("Items shown per record (default 5); item_count shows the total."),
    cursor: cursorSchema,
    limit: limitSchema(100, 25),
  },
  handler: async (args, ctx) => {
    if (args.sender && !args.rfc822_message_id) reject("sender can only be used together with rfc822_message_id.");
    const path = args.team_id ? buildPath`/beta/teams/${["team_id", args.team_id]}/reported_mail` : "/beta/reported_mail";
    const res = await ctx.client().get<ReportedMailListResponse>(path, {
      severity: args.severity,
      search: args.search,
      created_since: args.created_since,
      created_until: args.created_until,
      updated_since: args.updated_since,
      rfc822_message_id: args.rfc822_message_id,
      sender: args.sender,
      cursor: args.cursor,
      limit: args.limit,
    });
    const records = res.data.records ?? [];
    const bySeverity: Record<string, number> = {};
    for (const r of records) bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
    return {
      scope: args.team_id ?? "estate",
      ...pageInfo(res.data.pagination, records.length),
      poll_from: res.data.poll_from,
      page_severity_counts: bySeverity,
      records: records.map((r) => projectRecord(r, args.max_items_per_record ?? 5)),
    };
  },
});

export const reportedMailGetTool = defineTool({
  name: "inky_reported_mail_get",
  title: "Get INKY reported-mail record",
  domain: "reported_mail",
  description:
    "Get one reported-mail record with its items and user reports (beta; needs reported_mail.read). Works for records that already left the queue (fully remediated), so the outcome of a report is always readable.",
  inputSchema: {
    team_id: z.string().min(1).max(256).describe("team_id of the record, as returned by inky_reported_mail_list."),
    record_id: opaqueIdSchema("Record id (UUID)"),
    max_items: z.number().int().min(1).max(500).optional().describe("Items to show (default 100)."),
  },
  handler: async (args, ctx) => {
    const res = await ctx.client().get<ReportedMailRecord>(
      buildPath`/beta/teams/${["team_id", args.team_id]}/reported_mail/${["record_id", args.record_id]}`,
    );
    return projectRecord(res.data, args.max_items ?? 100);
  },
});

export const reportedMailItemActionsTool = defineTool({
  name: "inky_reported_mail_item_actions",
  title: "List actions for a reported item",
  domain: "reported_mail",
  description:
    "Preview the allow-list and block-list rules INKY can create from one reported item's message, with the exact criteria each would write and whether an equivalent rule already exists (beta). Read-only preview, but INKY gates it with the reported_mail.remediate permission, so a read-only key gets FORBIDDEN. This server never applies actions.",
  inputSchema: {
    team_id: z.string().min(1).max(256).describe("team_id of the record."),
    record_id: opaqueIdSchema("Record id (UUID)"),
    item_id: opaqueIdSchema("Item id (UUID) from the record's items"),
  },
  handler: async (args, ctx) => {
    const res = await ctx.client().get<{ actions: Array<Record<string, unknown>> }>(
      buildPath`/beta/teams/${["team_id", args.team_id]}/reported_mail/${["record_id", args.record_id]}/items/${["item_id", args.item_id]}/actions`,
    );
    return {
      team_id: args.team_id,
      record_id: args.record_id,
      item_id: args.item_id,
      actions: (res.data.actions ?? []).map((a) => {
        const criteria = a.criteria && typeof a.criteria === "object" ? compact(a.criteria as Record<string, unknown>) : a.criteria;
        return compact({ ...a, criteria });
      }),
      note: "Preview only. Applying an action is a write operation that this read-only server does not perform.",
    };
  },
});
