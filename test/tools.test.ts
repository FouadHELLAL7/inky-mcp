import { describe, expect, it } from "vitest";
import { connectClient, inkyError, json } from "./helpers.js";

const team = (id: string, label: string | null, domains: string[] = [], kind: "team" | "org" = "team") => ({
  team_id: id,
  teamid: id,
  kind,
  parent_teamid: kind === "org" ? null : "$msp",
  team_label: label,
  disabled: false,
  created_at: "2025-01-01T00:00:00Z",
  domains,
});

const message = (overrides: Record<string, unknown> = {}) => ({
  team_id: "leafcust",
  mailbox: "pat@cust.example",
  rfc822_message_id: "CAE1abc@mail.spoofed.example",
  received_at: "2026-11-08T14:05:00.331Z",
  subject: "Invoice payment update",
  sender: { email: "billing@spoofed.example", display_name: "Acme Billing", domain: "spoofed.example" },
  recipients: ["pat@cust.example"],
  threat_level: "danger",
  reasons: [{ code: "brand_impersonation", label: "Brand Impersonation" }],
  delivery_target: "junk",
  direction: "inbound",
  has_attachments: true,
  link_count: 3,
  reports: { open: 1, confirmed: 0, rejected: 0 },
  ...overrides,
});

describe("tool catalogue", () => {
  it("lists every tool as read-only with annotations and an input schema", async () => {
    const t = await connectClient(() => json({}));
    const { tools } = await t.client.listTools();
    expect(tools.length).toBe(24);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^inky_[a-z_]+$/);
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.description!.length, tool.name).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
    }
    await t.close();
  });

  it("inky_navigate groups tools by domain", async () => {
    const t = await connectClient(() => json({}));
    const res = await t.call("inky_navigate", { domain: "messages" });
    expect(res.json).toEqual({ messages: [{ name: "inky_messages_search", title: "Search INKY messages" }] });
    await t.close();
  });

  it("rejects invalid input before calling INKY", async () => {
    const t = await connectClient(() => json({}));
    const res = await t.call("inky_teams_list", { limit: 0 });
    expect(res.isError).toBe(true);
    const res2 = await t.call("inky_messages_search", { team_id: "t1", threat_level: "evil" });
    expect(res2.isError).toBe(true);
    expect(t.requests).toHaveLength(0);
    await t.close();
  });
});

describe("account tools", () => {
  it("inky_test_connection reports scope, permissions and usable tools", async () => {
    const t = await connectClient(() =>
      json(
        {
          teamid: "$msp",
          key_prefix: "inky_ext_TESTKEY",
          key_name: "MCP",
          key_type: "custom",
          scope_type: "org",
          permissions: { api_access: ["read"], messages: ["read"], statistics: ["read"] },
          expires_at: null,
          status: "active",
        },
        200,
        { "x-ratelimit-remaining": "42", "x-api-key-expires-soon": "true", "x-api-key-expires-at": "2026-12-01T00:00:00Z" },
      ),
    );
    const res = await t.call("inky_test_connection");
    expect(res.isError).toBe(false);
    expect(t.requests[0].url.pathname).toBe("/v1/me");
    expect(res.json.scope).toEqual({ root_team_id: "$msp", scope_type: "org" });
    expect(res.json.tools_this_key_can_use).toContain("inky_messages_search");
    expect(res.json.tools_this_key_can_use).not.toContain("inky_allow_list_list");
    expect((res.json.warnings as string[]).join(" ")).toContain("expires soon");
    await t.close();
  });

  it("inky_status works without an API key", async () => {
    const t = await connectClient(() => json({ status: "ok" }), { creds: { baseUrl: "https://api.eu.inkyphishfence.com", region: "eu" } });
    const res = await t.call("inky_status");
    expect(res.json).toMatchObject({ api_key_configured: false, region: "eu", inky_api_status: { status: "ok" } });
    expect(t.requests[0].headers["x-api-key"]).toBeUndefined();
    await t.close();
  });
});

describe("teams and usage", () => {
  it("inky_teams_list projects teams and exposes the next cursor", async () => {
    const t = await connectClient(() => json({ teams: [team("$msp", null, [], "org"), team("t1", "Acme", ["acme.com"])], pagination: { next_cursor: "c2", limit: 2 } }));
    const res = await t.call("inky_teams_list", { limit: 2 });
    expect(res.json).toMatchObject({ returned: 2, has_more: true, next_cursor: "c2" });
    expect((res.json.teams as unknown[])[1]).toMatchObject({ team_id: "t1", kind: "team", label: "Acme", domains: ["acme.com"] });
    expect(t.requests[0].url.searchParams.get("limit")).toBe("2");
    await t.close();
  });

  it("inky_teams_find walks every page and matches label or domain", async () => {
    const t = await connectClient((url) => {
      const cursor = url.searchParams.get("cursor");
      if (!cursor) return json({ teams: [team("t1", "Acme Corp", ["acme.com"]), team("t2", "Other", ["other.com"])], pagination: { next_cursor: "p2", limit: 999 } });
      return json({ teams: [team("t3", "Beta", ["mail.acme.com"])], pagination: { next_cursor: null, limit: 999 } });
    });
    const res = await t.call("inky_teams_find", { query: "ACME" });
    expect(t.requests).toHaveLength(2);
    expect(t.requests[0].url.searchParams.get("limit")).toBe("999");
    expect(t.requests[1].url.searchParams.get("cursor")).toBe("p2");
    expect(res.json).toMatchObject({ match_count: 2, nodes_scanned: 3, scan_complete: true });
    await t.close();
  });

  it("inky_usage_history validates the date mode", async () => {
    const t = await connectClient(() => json({}));
    expect((await t.call("inky_usage_history", { days: 10, start_date: "2026-01-01", end_date: "2026-01-31" })).isError).toBe(true);
    expect((await t.call("inky_usage_history", { start_date: "2026-01-01" })).isError).toBe(true);
    expect(t.requests).toHaveLength(0);
    await t.close();
  });

  it("inky_usage_get labels the estate-wide summary", async () => {
    const t = await connectClient(() =>
      json({ data_as_of: "2026-11-12", summary: { total_billable_mailboxes: 120 }, teams: [{ team_id: "t1", team_name: "Acme", billable_mailbox_count: 20, product_skus: ["P"] }], pagination: { next_cursor: null, limit: 50 } }),
    );
    const res = await t.call("inky_usage_get");
    expect(res.json).toMatchObject({ total_billable_mailboxes_all_teams: 120, returned: 1, has_more: false });
    await t.close();
  });
});

describe("inky_messages_search", () => {
  it("builds the documented query and projects rows", async () => {
    const t = await connectClient(() => json({ messages: [message(), message({ threat_level: "neutral", reasons: [] })], pagination: { next_cursor: "m2", limit: 25 } }));
    const res = await t.call("inky_messages_search", {
      team_id: "$msp",
      recipient: "pat@cust.example",
      since: "2026-11-01T00:00:00Z",
      until: "2026-11-10T00:00:00Z",
      reason: ["brand_impersonation", "spam_content"],
      reported: true,
      limit: 25,
    });
    expect(res.isError).toBe(false);
    const url = t.requests[0].url;
    expect(url.pathname).toBe("/beta/teams/%24msp/messages");
    expect(url.searchParams.getAll("reason")).toEqual(["brand_impersonation", "spam_content"]);
    expect(url.searchParams.get("reported")).toBe("true");
    expect(url.searchParams.has("detail")).toBe(false);
    expect(url.searchParams.has("subject")).toBe(false);
    expect(res.json).toMatchObject({ returned: 2, next_cursor: "m2", page_threat_levels: { danger: 1, neutral: 1 } });
    const first = (res.json.messages as Array<Record<string, unknown>>)[0];
    expect(first).toMatchObject({ mailbox: "pat@cust.example", threat_level: "danger", sender: { email: "billing@spoofed.example" } });
    await t.close();
  });

  it("caps links and long subjects in detail mode", async () => {
    const links = Array.from({ length: 40 }, (_, i) => ({ url: `https://x${i}.example/`, domain: `x${i}.example` }));
    const t = await connectClient(() => json({ messages: [message({ subject: "S".repeat(1000), links, total_links: 40, sender_ip: "203.0.113.5", provider_signals: { microsoft_scl: 5, google_spam: null } })], pagination: { next_cursor: null, limit: 25 } }));
    const res = await t.call("inky_messages_search", { team_id: "t1", detail: true });
    expect(t.requests[0].url.searchParams.get("detail")).toBe("true");
    const row = (res.json.messages as Array<Record<string, unknown>>)[0];
    expect((row.links as unknown[]).length).toBe(25);
    expect(row.links_omitted).toBe(15);
    expect(String(row.subject).length).toBeLessThan(400);
    expect(row.provider_signals).toEqual({ microsoft_scl: 5 });
    await t.close();
  });

  it("rejects windows longer than 90 days locally", async () => {
    const t = await connectClient(() => json({}));
    const res = await t.call("inky_messages_search", { team_id: "t1", since: "2026-01-01T00:00:00Z", until: "2026-06-01T00:00:00Z" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("90 days");
    expect(t.requests).toHaveLength(0);
    await t.close();
  });

  it("surfaces FORBIDDEN with guidance to check permissions", async () => {
    const t = await connectClient(() => inkyError(403, "FORBIDDEN", "Missing permission messages.read"));
    const res = await t.call("inky_messages_search", { team_id: "t1" });
    expect(res.isError).toBe(true);
    expect(res.json.error).toMatchObject({ code: "FORBIDDEN", http_status: 403, request_id: "req-FORBIDDEN" });
    expect(res.text).toContain("inky_test_connection");
    await t.close();
  });
});

describe("statistics", () => {
  const days = [
    { date: "2026-11-01", neutral: 90, caution: 8, danger: 2 },
    { date: "2026-11-02", neutral: 80, caution: 10, danger: 10 },
  ];
  const reasons = [
    { date: "2026-11-01", reason: "spam_content", label: "Spam", count: 5 },
    { date: "2026-11-02", reason: "spam_content", label: "Spam", count: 4 },
    { date: "2026-11-02", reason: "brand_impersonation", label: "Brand Impersonation", count: 7 },
    { date: "2026-11-02", reason: null, label: null, count: 1 },
  ];

  it("inky_threat_summary aggregates verdicts, peak days and top reasons", async () => {
    const t = await connectClient((url) =>
      url.pathname.endsWith("/reasons")
        ? json({ team_id: "t1", since: "2026-11-01", until: "2026-11-02", reasons })
        : json({ team_id: "t1", since: "2026-11-01", until: "2026-11-02", days }),
    );
    const res = await t.call("inky_threat_summary", { team_id: "t1", since: "2026-11-01", until: "2026-11-02" });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ inbound_messages: 200, verdicts: { neutral: 170, caution: 18, danger: 12, danger_pct: 6 } });
    expect((res.json.peak_danger_days as Array<{ date: string }>)[0].date).toBe("2026-11-02");
    const top = res.json.top_reasons as Array<{ reason: string; count: number }>;
    expect(top[0]).toMatchObject({ reason: "spam_content", count: 9 });
    expect(top[1]).toMatchObject({ reason: "brand_impersonation", count: 7 });
    expect(t.requests.map((r) => r.url.searchParams.get("since"))).toEqual(["2026-11-01", "2026-11-01"]);
    await t.close();
  });

  it("inky_statistics_get refuses until=today and misplaced reason filters", async () => {
    const t = await connectClient(() => json({}));
    const today = new Date().toISOString().slice(0, 10);
    expect((await t.call("inky_statistics_get", { team_id: "t1", until: today })).isError).toBe(true);
    expect((await t.call("inky_statistics_get", { team_id: "t1", reason: ["spam_content"] })).isError).toBe(true);
    expect(t.requests).toHaveLength(0);
    await t.close();
  });

  it("inky_statistics_get result_category totals", async () => {
    const t = await connectClient(() =>
      json({ team_id: "t1", since: "2026-11-01", until: "2026-11-02", result_categories: [{ date: "2026-11-01", result_category: "danger", count: 2 }, { date: "2026-11-02", result_category: "danger", count: 3 }, { date: "2026-11-02", result_category: null, count: 1 }] }),
    );
    const res = await t.call("inky_statistics_get", { team_id: "t1", breakdown: "result_category" });
    expect(t.requests[0].url.pathname).toBe("/beta/teams/t1/statistics/result_categories");
    expect(res.json.totals_by_result_category).toEqual({ danger: 5, uncategorised: 1 });
    await t.close();
  });
});

describe("reported mail", () => {
  const record = {
    id: "11111111-1111-1111-1111-111111111111",
    team_id: "t1",
    title: "Suspicious invoice",
    status: "open",
    priority: "high",
    severity: "high",
    queue_route: "false_negative_phishing",
    item_count: 12,
    items: Array.from({ length: 12 }, (_, i) => ({
      id: `item-${i}`,
      status: "open",
      sender: "billing@spoofed.example",
      rfc822_message_id: "CAE1abc@mail.spoofed.example",
      reports: [{ id: i, label: "phish", status: "open", contact_email: "pat@cust.example", comment: "looks fake", reported_at: "2026-11-08T15:00:00Z" }],
    })),
  };

  it("lists estate-wide by default, caps items per record and returns poll_from", async () => {
    const t = await connectClient(() => json({ records: [record], pagination: { next_cursor: null, limit: 25 }, poll_from: "2026-11-13T10:00:00Z" }));
    const res = await t.call("inky_reported_mail_list", { severity: "high", max_items_per_record: 3 });
    expect(t.requests[0].url.pathname).toBe("/beta/reported_mail");
    expect(t.requests[0].url.searchParams.get("severity")).toBe("high");
    expect(res.json).toMatchObject({ scope: "estate", poll_from: "2026-11-13T10:00:00Z", page_severity_counts: { high: 1 } });
    const r = (res.json.records as Array<Record<string, unknown>>)[0];
    expect((r.items as unknown[]).length).toBe(3);
    expect(r.items_omitted).toBe(9);
    await t.close();
  });

  it("uses the per-team path and validates sender without message id", async () => {
    const t = await connectClient(() => json({ records: [], pagination: { next_cursor: null, limit: 25 }, poll_from: "x" }));
    expect((await t.call("inky_reported_mail_list", { sender: "a@b.c" })).isError).toBe(true);
    await t.call("inky_reported_mail_list", { team_id: "$org", rfc822_message_id: "<abc@host>", sender: "a@b.c" });
    expect(t.requests[0].url.pathname).toBe("/beta/teams/%24org/reported_mail");
    await t.close();
  });

  it("explains POLLED_TOO_SOON instead of retrying", async () => {
    const t = await connectClient(() => inkyError(429, "POLLED_TOO_SOON", "same first page", { "retry-after": "45" }));
    const res = await t.call("inky_reported_mail_list");
    expect(res.isError).toBe(true);
    expect(res.json.error).toMatchObject({ code: "POLLED_TOO_SOON", retry_after_seconds: 45 });
    expect(t.requests).toHaveLength(1);
    expect(t.sleeps).toEqual([]);
    await t.close();
  });

  it("inky_reported_mail_get encodes ids", async () => {
    const t = await connectClient(() => json(record));
    const res = await t.call("inky_reported_mail_get", { team_id: "t1", record_id: record.id, max_items: 2 });
    expect(t.requests[0].url.pathname).toBe(`/beta/teams/t1/reported_mail/${record.id}`);
    expect(res.json).toMatchObject({ record_id: record.id, item_count: 12, items_omitted: 10 });
    await t.close();
  });
});

describe("allow/block lists, VIPs and admins", () => {
  it("allow list: estate vs team paths, inherited only with team_id", async () => {
    const t = await connectClient(() => json({ allow_list: [{ id: "1", shape: "sender", team_id: "t1", result_type: "*", sender: "x.com", user_email: null, enabled: true, inherited: false }], pagination: { next_cursor: null, limit: 50 } }));
    expect((await t.call("inky_allow_list_list", { inherited: false })).isError).toBe(true);
    const res = await t.call("inky_allow_list_list", { result_type: "*" });
    expect(t.requests[0].url.pathname).toBe("/beta/allow_list");
    expect(t.requests[0].url.searchParams.get("result_type")).toBe("*");
    expect((res.json.allow_list as Array<Record<string, unknown>>)[0]).not.toHaveProperty("user_email");
    await t.call("inky_allow_list_list", { team_id: "t1", inherited: false });
    expect(t.requests[1].url.pathname).toBe("/beta/teams/t1/allow_list");
    expect(t.requests[1].url.searchParams.get("inherited")).toBe("false");
    await t.close();
  });

  it("block list filters", async () => {
    const t = await connectClient(() => json({ block_list: [], pagination: { next_cursor: null, limit: 50 } }));
    await t.call("inky_block_list_list", { team_id: "t1", from_domain: "spam.example", enabled: true });
    expect(t.requests[0].url.search).toBe("?from_domain=spam.example&enabled=true");
    await t.close();
  });

  it("admins: email filter only estate-wide; get encodes email", async () => {
    const t = await connectClient(() => json({ principal: { type: "email", email: "a@b.c" }, scope_grants: [] }));
    expect((await t.call("inky_admins_list", { team_id: "t1", email: "a@b.c" })).isError).toBe(true);
    await t.call("inky_admins_get", { team_id: "t1", email: "pat+x@cust.example" });
    expect(t.requests[0].url.pathname).toBe("/beta/teams/t1/admins/pat%2Bx%40cust.example");
    await t.close();
  });

  it("vips and result types", async () => {
    const t = await connectClient((url) =>
      url.pathname === "/beta/result_types"
        ? json({ result_types: [{ code: "spam_content", label: "Spam", lists: ["allow", "block"] }, { code: "x", label: "X", lists: ["allow"] }] })
        : json({ vips: [{ id: "v1", team_id: "t1", first_name: "Pat", last_name: "Lee", email: "pat@cust.example" }], pagination: { next_cursor: null, limit: 50 } }),
    );
    const vips = await t.call("inky_vips_list", { last_name: "Lee" });
    expect(t.requests[0].url.pathname).toBe("/beta/vips");
    expect(vips.json.returned).toBe(1);
    const rt = await t.call("inky_result_types_list", { list: "block" });
    expect(rt.json.count).toBe(1);
    expect(t.requests[1].url.search).toBe("");
    await t.close();
  });
});

describe("output budget", () => {
  it("shortens the main array instead of cutting JSON", async () => {
    const teams = Array.from({ length: 400 }, (_, i) => team(`t${i}`, `Team ${i} ${"x".repeat(100)}`, ["a.example", "b.example"]));
    const t = await connectClient(() => json({ teams, pagination: { next_cursor: null, limit: 999 } }), { config: { maxOutputChars: 10_000 } });
    const res = await t.call("inky_teams_list", { limit: 999 });
    expect(res.text.length).toBeLessThanOrEqual(10_000);
    expect(res.json.output_truncated).toMatchObject({ field: "teams" });
    await t.close();
  });
});
