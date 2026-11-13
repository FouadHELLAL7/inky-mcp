import { describe, expect, it } from "vitest";
import { RequestRejectedError } from "../src/errors.js";
import { RAW_GET_TEMPLATES, validateRawPath, validateRawQuery } from "../src/tools/raw.js";
import { connectClient, json } from "./helpers.js";

describe("validateRawPath", () => {
  it("accepts documented GET templates and canonicalises encoding", () => {
    expect(validateRawPath("/v1/teams").path).toBe("/v1/teams");
    expect(validateRawPath("/v1/teams/").path).toBe("/v1/teams");
    expect(validateRawPath("/beta/teams/$org1/messages")).toEqual({ path: "/beta/teams/%24org1/messages", template: "/beta/teams/{team_id}/messages" });
    expect(validateRawPath("/beta/teams/%24org1/statistics/reasons").path).toBe("/beta/teams/%24org1/statistics/reasons");
    expect(validateRawPath("/beta/teams/t1/admins/pat%40cust.example").path).toBe("/beta/teams/t1/admins/pat%40cust.example");
  });

  it.each([
    ["absolute URL", "https://evil.example/v1/teams"],
    ["scheme-relative", "//evil.example/v1/teams"],
    ["no leading slash", "v1/teams"],
    ["traversal", "/v1/teams/../me"],
    ["encoded traversal", "/beta/teams/%2e%2e/messages"],
    ["encoded slash", "/beta/teams/a%2Fb/messages"],
    ["double encoding", "/beta/teams/a%252Fb/messages"],
    ["backslash", "/beta/teams/a\\b/messages"],
    ["query in path", "/v1/teams?limit=1"],
    ["fragment", "/v1/teams#x"],
    ["empty segment", "/v1//teams"],
    ["whitespace", "/v1/te ams"],
    ["control char", "/v1/teams\n"],
    ["invalid percent", "/beta/teams/%zz/messages"],
    ["write-only verb", "/beta/reported_mail:remediate"],
    ["write-only batch", "/beta/teams/t1/allow_list:batch"],
    ["undocumented", "/v1/admin/keys"],
    ["openapi doc", "/v1/openapi.json"],
    ["javascript scheme", "javascript:alert(1)"],
  ])("rejects %s", (_label, path) => {
    expect(() => validateRawPath(path)).toThrow(RequestRejectedError);
  });

  it("covers every documented GET path exactly once", () => {
    expect(new Set(RAW_GET_TEMPLATES).size).toBe(RAW_GET_TEMPLATES.length);
    expect(RAW_GET_TEMPLATES).toHaveLength(27);
  });
});

describe("validateRawQuery", () => {
  it("rejects odd parameter names and too many parameters", () => {
    expect(() => validateRawQuery({ "X-API-Key": "x" })).toThrow(RequestRejectedError);
    expect(() => validateRawQuery({ "a[b]": "x" })).toThrow(RequestRejectedError);
    const many = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, "v"]));
    expect(() => validateRawQuery(many)).toThrow(RequestRejectedError);
    expect(validateRawQuery({ limit: 5, reason: ["a"] })).toEqual({ limit: 5, reason: ["a"] });
  });
});

describe("inky_raw_request tool", () => {
  it("sends a GET to the configured origin only and returns the JSON", async () => {
    const t = await connectClient(() => json({ teams: [] }, 200, { "x-request-id": "r1" }));
    const res = await t.call("inky_raw_request", { path: "/v1/teams", query: { limit: 5 } });
    expect(res.isError).toBe(false);
    expect(res.json.request).toEqual({ method: "GET", path: "/v1/teams", template: "/v1/teams" });
    expect(t.requests[0].url.href).toBe("https://api.eu.inkyphishfence.com/v1/teams?limit=5");
    expect(t.requests[0].method).toBe("GET");
    await t.close();
  });

  it("refuses unsafe paths without calling INKY", async () => {
    const t = await connectClient(() => json({}));
    const res = await t.call("inky_raw_request", { path: "https://evil.example/v1/me" });
    expect(res.isError).toBe(true);
    expect(res.json.error).toMatchObject({ code: "REQUEST_REJECTED" });
    expect(t.requests).toHaveLength(0);
    await t.close();
  });

  it("is not registered when INKY_ENABLE_RAW_REQUEST=false", async () => {
    const t = await connectClient(() => json({}), { config: { rawRequestEnabled: false } });
    const tools = await t.client.listTools();
    expect(tools.tools.map((x) => x.name)).not.toContain("inky_raw_request");
    await t.close();
  });
});
