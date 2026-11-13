import { describe, expect, it } from "vitest";
import { InkyApiError, MissingCredentialsError, RequestRejectedError, formatToolError } from "../src/errors.js";
import { InkyClient, buildPath, encodeSegment } from "../src/inky-client.js";
import { EU_CREDS, TEST_KEY, inkyError, json, mockFetch, testConfig } from "./helpers.js";

function client(route: Parameters<typeof mockFetch>[0], configOverrides = {}) {
  const mock = mockFetch(route);
  const sleeps: number[] = [];
  const c = new InkyClient(EU_CREDS, testConfig(configOverrides), { fetch: mock.fetch, sleep: async (ms) => void sleeps.push(ms) });
  return { c, requests: mock.requests, sleeps };
}

describe("request construction", () => {
  it("sends the key only as X-API-Key to the configured origin, with GET and manual redirects", async () => {
    const { c, requests } = client(() => json({ teams: [], pagination: { next_cursor: null, limit: 50 } }));
    await c.get("/v1/teams", { limit: 10, cursor: undefined, flag: true, reason: ["a", "b"] });
    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.method).toBe("GET");
    expect(req.redirect).toBe("manual");
    expect(req.url.origin).toBe("https://api.eu.inkyphishfence.com");
    expect(req.url.pathname).toBe("/v1/teams");
    expect(req.url.searchParams.get("limit")).toBe("10");
    expect(req.url.searchParams.has("cursor")).toBe(false);
    expect(req.url.searchParams.getAll("reason")).toEqual(["a", "b"]);
    expect(req.headers["x-api-key"]).toBe(TEST_KEY);
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers.cookie).toBeUndefined();
  });

  it("omits the key for unauthenticated calls", async () => {
    const { c, requests } = client(() => json({ status: "ok" }));
    await c.get("/v1/status", undefined, { authenticated: false });
    expect(requests[0].headers["x-api-key"]).toBeUndefined();
  });

  it("refuses authenticated calls without a key", async () => {
    const mock = mockFetch(() => json({}));
    const c = new InkyClient({ ...EU_CREDS, apiKey: undefined }, testConfig(), { fetch: mock.fetch });
    await expect(c.get("/v1/me")).rejects.toBeInstanceOf(MissingCredentialsError);
    expect(mock.requests).toHaveLength(0);
  });

  it("encodes dynamic path segments and refuses dot segments", () => {
    expect(buildPath`/beta/teams/${["team_id", "$org1"]}/messages`).toBe("/beta/teams/%24org1/messages");
    expect(buildPath`/x/${["email", "a/b@c.d"]}`).toBe("/x/a%2Fb%40c.d");
    expect(() => encodeSegment("..", "team_id")).toThrow(RequestRejectedError);
    expect(() => encodeSegment("a\nb", "team_id")).toThrow(RequestRejectedError);
    expect(() => encodeSegment("", "team_id")).toThrow(RequestRejectedError);
  });

  it("refuses paths that would leave the configured origin", () => {
    const { c } = client(() => json({}));
    expect(() => c.resolveUrl("//evil.example/v1/me")).toThrow(RequestRejectedError);
    expect(() => c.resolveUrl("https://evil.example/v1/me")).toThrow(RequestRejectedError);
    expect(c.resolveUrl("/v1/me").origin).toBe("https://api.eu.inkyphishfence.com");
  });

  it("returns rate-limit and key-expiry headers", async () => {
    const { c } = client(() =>
      json({ ok: 1 }, 200, {
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "99",
        "x-ratelimit-reset": "1763000000",
        "x-request-id": "rid-1",
        "x-api-key-expires-soon": "true",
        "x-api-key-expires-at": "2026-12-01T00:00:00Z",
      }),
    );
    const res = await c.get("/v1/me");
    expect(res.rateLimit).toEqual({ limit: 100, remaining: 99, reset: 1763000000 });
    expect(res.requestId).toBe("rid-1");
    expect(res.keyExpiresSoon).toBe(true);
    expect(res.keyExpiresAt).toBe("2026-12-01T00:00:00Z");
  });
});

describe("error handling", () => {
  it.each([
    [401, "INVALID_API_KEY"],
    [401, "EXPIRED_API_KEY"],
    [403, "FORBIDDEN"],
    [403, "NOT_ENTITLED"],
    [404, "NOT_FOUND"],
    [400, "VALIDATION_ERROR"],
  ])("maps %i %s without retrying", async (status, code) => {
    const { c, requests } = client(() => inkyError(status, code, `msg ${code}`));
    const err = await c.get("/v1/me").catch((e) => e);
    expect(err).toBeInstanceOf(InkyApiError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.requestId).toBe(`req-${code}`);
    expect(requests).toHaveLength(1);
  });

  it("falls back to a status-derived code for non-JSON errors", async () => {
    const { c } = client(() => new Response("<html>bad gateway</html>", { status: 404 }));
    const err = await c.get("/v1/me").catch((e) => e);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("formats errors with guidance and request id but never the key", async () => {
    const { c } = client(() => inkyError(401, "INVALID_API_KEY", `key ${TEST_KEY} rejected`));
    const err = await c.get("/v1/me").catch((e) => e);
    const text = formatToolError(err);
    expect(text).toContain("INVALID_API_KEY");
    expect(text).toContain("region");
    expect(text).toContain("req-INVALID_API_KEY");
    expect(text).not.toContain(TEST_KEY);
  });

  it("does not follow redirects", async () => {
    const { c, requests } = client(() => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
    const err = await c.get("/v1/me").catch((e) => e);
    expect(err.code).toBe("UNEXPECTED_REDIRECT");
    expect(requests).toHaveLength(1);
  });

  it("caps response size", async () => {
    const { c } = client(() => json({ blob: "x".repeat(200_000) }), { maxResponseBytes: 64 * 1024 });
    const err = await c.get("/v1/teams").catch((e) => e);
    expect(err.code).toBe("RESPONSE_TOO_LARGE");
  });

  it("maps timeouts", async () => {
    const { c } = client(() => {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    });
    const err = await c.get("/v1/me").catch((e) => e);
    expect(err.code).toBe("TIMEOUT");
  });

  it("rejects non-JSON success bodies", async () => {
    const { c } = client(() => new Response("not json", { status: 200 }));
    const err = await c.get("/v1/me").catch((e) => e);
    expect(err.code).toBe("INVALID_RESPONSE");
  });
});

describe("retries", () => {
  it("honours Retry-After on 429 RATE_LIMITED and then succeeds", async () => {
    let n = 0;
    const { c, requests, sleeps } = client(() => (++n === 1 ? inkyError(429, "RATE_LIMITED", "slow down", { "retry-after": "3" }) : json({ ok: true })));
    const res = await c.get<{ ok: boolean }>("/v1/teams");
    expect(res.data.ok).toBe(true);
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });

  it("never retries POLLED_TOO_SOON", async () => {
    const { c, requests } = client(() => inkyError(429, "POLLED_TOO_SOON", "again", { "retry-after": "40" }));
    const err = await c.get("/beta/reported_mail").catch((e) => e);
    expect(err.code).toBe("POLLED_TOO_SOON");
    expect(err.retryAfterSeconds).toBe(40);
    expect(requests).toHaveLength(1);
    expect(formatToolError(err)).toContain("updated_since");
  });

  it("never retries AUDIT_UNAVAILABLE", async () => {
    const { c, requests } = client(() => inkyError(500, "AUDIT_UNAVAILABLE"));
    await c.get("/v1/me").catch(() => undefined);
    expect(requests).toHaveLength(1);
  });

  it("retries 500/503 with bounded attempts", async () => {
    const { c, requests, sleeps } = client(() => inkyError(503, "SERVICE_OVERLOADED", "busy", { "retry-after": "1" }), { maxRetries: 2 });
    const err = await c.get("/v1/me").catch((e) => e);
    expect(err.code).toBe("SERVICE_OVERLOADED");
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("does not retry an UPSTREAM_UNAVAILABLE that says the family is not deployed", async () => {
    const { c, requests } = client(() => inkyError(503, "UPSTREAM_UNAVAILABLE", "Message data is not available in this deployment"));
    await c.get("/beta/teams/t1/messages").catch(() => undefined);
    expect(requests).toHaveLength(1);
  });

  it("gives up instead of waiting longer than INKY_MAX_RETRY_WAIT_SECONDS", async () => {
    const { c, requests, sleeps } = client(() => inkyError(429, "RATE_LIMITED", "wait", { "retry-after": "600" }), { maxRetryWaitSeconds: 30 });
    const err = await c.get("/v1/teams").catch((e) => e);
    expect(err.retryAfterSeconds).toBe(600);
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("retries network errors with exponential backoff", async () => {
    let n = 0;
    const { c, requests, sleeps } = client(() => {
      if (++n < 3) throw new TypeError("fetch failed");
      return json({ ok: true });
    });
    await c.get("/v1/me");
    expect(requests).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThanOrEqual(1000);
  });
});
