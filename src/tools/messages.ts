import { z } from "zod";
import { buildPath } from "../inky-client.js";
import {
  capList,
  clip,
  compact,
  cursorSchema,
  dateTimeSchema,
  defineTool,
  emailSchema,
  limitSchema,
  pageInfo,
  reject,
  teamIdSchema,
  type Pagination,
} from "./common.js";

interface Address {
  email?: string | null;
  display_name?: string | null;
}

interface MessageRecord {
  team_id: string;
  mailbox?: string | null;
  rfc822_message_id?: string | null;
  received_at?: string | null;
  subject?: string | null;
  sender?: { email?: string | null; display_name?: string | null; domain?: string | null };
  recipients?: string[];
  threat_level?: string | null;
  reasons?: Array<{ code?: string | null; label?: string | null }>;
  delivery_target?: string | null;
  has_attachments?: boolean;
  link_count?: number;
  reports?: { open: number; confirmed: number; rejected: number };
  // detail=true fields
  links?: Array<{ url: string; domain?: string | null }>;
  total_links?: number;
  attachments?: Array<{ filename?: string | null; content_type?: string | null; size?: number | null; sha256?: string | null }>;
  reply_to?: Address[];
  to?: Address[];
  cc?: Address[];
  bcc?: Address[];
  sender_ip?: string | null;
  sender_country_code?: string | null;
  sender_country_name?: string | null;
  helo?: string | null;
  envelope_from?: string | null;
  origin?: string | null;
  known_external_sender?: boolean | null;
  result_category?: string | null;
  provider_signals?: Record<string, unknown>;
}

interface MessagesListResponse {
  messages: MessageRecord[];
  pagination: Pagination;
}

const MAX_WINDOW_MS = 90 * 86_400_000;

function addresses(list: Address[] | undefined, max: number) {
  const capped = capList(list, max);
  return capped.items.map((a) => compact({ email: a.email, name: a.display_name }));
}

export function projectMessage(m: MessageRecord, detail: boolean): Record<string, unknown> {
  const recipients = capList(m.recipients, 10);
  const row: Record<string, unknown> = compact({
    team_id: m.team_id,
    mailbox: m.mailbox,
    received_at: m.received_at,
    rfc822_message_id: m.rfc822_message_id,
    subject: clip(m.subject, 300),
    sender: m.sender ? compact({ email: m.sender.email, name: m.sender.display_name, domain: m.sender.domain }) : undefined,
    threat_level: m.threat_level,
    reasons: (m.reasons ?? []).map((r) => compact({ code: r.code, label: r.label })),
    delivery_target: m.delivery_target,
    result_category: m.result_category,
    has_attachments: m.has_attachments,
    link_count: m.link_count,
    user_reports: m.reports,
    recipients: recipients.items,
    recipients_omitted: recipients.omitted || undefined,
  });
  if (!detail) return row;
  const links = capList(m.links, 25);
  const attachments = capList(m.attachments, 25);
  return {
    ...row,
    ...compact({
      links: links.items.map((l) => compact({ url: clip(l.url, 500), domain: l.domain })),
      total_links: m.total_links,
      links_omitted: links.omitted || undefined,
      attachments: attachments.items.map((a) => compact({ ...a })),
      attachments_omitted: attachments.omitted || undefined,
      reply_to: addresses(m.reply_to, 10),
      to: addresses(m.to, 20),
      cc: addresses(m.cc, 20),
      bcc: addresses(m.bcc, 20),
      sender_ip: m.sender_ip,
      sender_country: m.sender_country_code ? `${m.sender_country_code}${m.sender_country_name ? ` (${m.sender_country_name})` : ""}` : undefined,
      helo: m.helo,
      envelope_from: m.envelope_from,
      origin: m.origin,
      known_external_sender: m.known_external_sender,
      provider_signals: m.provider_signals ? compact({ ...m.provider_signals }) : undefined,
    }),
  };
}

export const messagesSearchTool = defineTool({
  name: "inky_messages_search",
  title: "Search INKY messages",
  domain: "messages",
  description:
    "Search the analysis records of inbound mail INKY processed (GET /beta/teams/{team_id}/messages, beta; needs messages.read). Newest first. Exact-match filters ANDed together: recipient (start of most investigations), sender, from_domain, rfc822_message_id (correlate with SIEM/reported mail), threat_level, reason codes, delivery_target, result_category, reported. Pass an organization node as team_id to search every team beneath it. Window defaults to the last 7 days and may not exceed 90 days. No subject/free-text search exists. detail=true adds links, attachments (name/type/size/SHA-256), Reply-To/To/Cc, sender IP/country, HELO and provider spam signals. Message bodies are never available. A copy is identified by team_id + mailbox + rfc822_message_id + received_at.",
  inputSchema: {
    team_id: teamIdSchema,
    since: dateTimeSchema("Start of the window; default 7 days before until"),
    until: dateTimeSchema("End of the window; default now"),
    recipient: emailSchema("Protected mailbox the message was delivered to (exact, case-insensitive)."),
    sender: emailSchema("From address (exact, case-insensitive)."),
    from_domain: z.string().min(1).max(253).optional().describe("From domain (exact, not a suffix match)."),
    rfc822_message_id: z.string().min(1).max(998).optional().describe("RFC822 Message-ID header, with or without angle brackets (case-sensitive)."),
    threat_level: z.enum(["danger", "caution", "neutral"]).optional().describe("INKY's overall verdict."),
    reason: z.array(z.string().min(1).max(100)).min(1).max(20).optional().describe("Detection codes as returned in reasons[].code; matches any of them."),
    delivery_target: z.enum(["inbox", "junk", "user_quarantine", "admin_quarantine"]).optional().describe("Where INKY delivered the message."),
    result_category: z
      .enum(["neutral", "caution-non-spam", "caution-spam", "caution-hi-spam", "danger", "danger-hi"])
      .optional()
      .describe("INKY's finer-grained result category."),
    reported: z.boolean().optional().describe("true: only messages a user reported; false: only unreported."),
    detail: z.boolean().optional().describe("Return the full analysis record per row (larger). Default false."),
    cursor: cursorSchema,
    limit: limitSchema(100, 25),
  },
  handler: async (args, ctx) => {
    const since = args.since ? Date.parse(args.since) : undefined;
    const until = args.until ? Date.parse(args.until) : Date.now();
    if (since !== undefined && since >= until) reject("since must be before until.");
    if (since !== undefined && until - since > MAX_WINDOW_MS) reject("The window between since and until may not exceed 90 days. Split the search into windows of at most 90 days.");

    const detail = args.detail ?? false;
    const res = await ctx.client().get<MessagesListResponse>(buildPath`/beta/teams/${["team_id", args.team_id]}/messages`, {
      since: args.since,
      until: args.until,
      recipient: args.recipient,
      sender: args.sender,
      from_domain: args.from_domain,
      rfc822_message_id: args.rfc822_message_id,
      threat_level: args.threat_level,
      reason: args.reason,
      delivery_target: args.delivery_target,
      result_category: args.result_category,
      reported: args.reported,
      detail: detail ? true : undefined,
      cursor: args.cursor,
      limit: args.limit,
    });
    const messages = res.data.messages ?? [];
    const byThreat: Record<string, number> = {};
    for (const m of messages) {
      const key = m.threat_level ?? "unknown";
      byThreat[key] = (byThreat[key] ?? 0) + 1;
    }
    return {
      ...pageInfo(res.data.pagination, messages.length),
      window: { since: args.since ?? "default (until - 7 days)", until: args.until ?? "now" },
      page_threat_levels: byThreat,
      messages: messages.map((m) => projectMessage(m, detail)),
    };
  },
});
