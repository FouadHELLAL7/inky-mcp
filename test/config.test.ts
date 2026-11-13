import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { envCredentialResolver, gatewayCredentialsFromHeaders } from "../src/credentials.js";
import { redact } from "../src/logger.js";
import { TEST_KEY } from "./helpers.js";

describe("config", () => {
  it("defaults to the US region and documented limits", () => {
    const c = loadConfig({});
    expect(c.defaultRegion).toBe("us");
    expect(c.timeoutMs).toBe(30_000);
    expect(c.maxRetries).toBe(2);
    expect(c.rawRequestEnabled).toBe(true);
  });

  it("selects the EU origin from INKY_REGION", () => {
    const c = loadConfig({ INKY_REGION: "EU" });
    expect(envCredentialResolver(c, { INKY_API_KEY: TEST_KEY })().baseUrl).toBe("https://api.eu.inkyphishfence.com");
  });

  it("accepts only documented INKY origins for INKY_API_BASE_URL", () => {
    expect(loadConfig({ INKY_API_BASE_URL: "https://api.eu.inkyphishfence.com/" }).pinnedBaseUrl).toBe("https://api.eu.inkyphishfence.com");
    expect(loadConfig({ INKY_API_BASE_URL: "https://api.eu.inkyphishfence.com" }).defaultRegion).toBe("eu");
    for (const bad of [
      "https://evil.example",
      "http://api.eu.inkyphishfence.com",
      "https://api.eu.inkyphishfence.com/v1",
      "https://user:pw@api.eu.inkyphishfence.com",
      "https://api.eu.inkyphishfence.com.evil.example",
      "https://docs.eu.inkyphishfence.com",
    ]) {
      expect(() => loadConfig({ INKY_API_BASE_URL: bad }), bad).toThrow(ConfigError);
    }
  });

  it("rejects conflicting region and base URL, unknown regions and bad numbers", () => {
    expect(() => loadConfig({ INKY_REGION: "us", INKY_API_BASE_URL: "https://api.eu.inkyphishfence.com" })).toThrow(ConfigError);
    expect(() => loadConfig({ INKY_REGION: "apac" })).toThrow(ConfigError);
    expect(() => loadConfig({ INKY_TIMEOUT_MS: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ INKY_ENABLE_RAW_REQUEST: "maybe" })).toThrow(ConfigError);
  });

  it("allows INKY_TEST_BASE_URL only for http loopback", () => {
    expect(loadConfig({ INKY_TEST_BASE_URL: "http://127.0.0.1:9999" }).testBaseUrl).toBe("http://127.0.0.1:9999");
    expect(() => loadConfig({ INKY_TEST_BASE_URL: "http://10.0.0.5:9999" })).toThrow(ConfigError);
    expect(() => loadConfig({ INKY_TEST_BASE_URL: "https://evil.example" })).toThrow(ConfigError);
  });
});

describe("gateway credential headers", () => {
  const config = loadConfig({ INKY_REGION: "us" });

  it("requires X-Inky-Api-Key", () => {
    const r = gatewayCredentialsFromHeaders({}, config);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(JSON.stringify(r.body)).toContain("X-Inky-Api-Key");
    }
  });

  it("uses X-Inky-Region per request and falls back to the server default region", () => {
    const eu = gatewayCredentialsFromHeaders({ "x-inky-api-key": TEST_KEY, "x-inky-region": "eu" }, config);
    const def = gatewayCredentialsFromHeaders({ "x-inky-api-key": TEST_KEY }, config);
    expect(eu.ok && eu.credentials.baseUrl).toBe("https://api.eu.inkyphishfence.com");
    expect(def.ok && def.credentials.baseUrl).toBe("https://api.inkyphishfence.com");
  });

  it("rejects unknown regions and malformed keys", () => {
    const badRegion = gatewayCredentialsFromHeaders({ "x-inky-api-key": TEST_KEY, "x-inky-region": "https://evil.example" }, config);
    expect(badRegion.ok).toBe(false);
    if (!badRegion.ok) expect(badRegion.status).toBe(400);
    const badKey = gatewayCredentialsFromHeaders({ "x-inky-api-key": "has space in it" }, config);
    expect(badKey.ok).toBe(false);
  });

  it("refuses a region that conflicts with a pinned base URL", () => {
    const pinned = loadConfig({ INKY_API_BASE_URL: "https://api.eu.inkyphishfence.com" });
    const r = gatewayCredentialsFromHeaders({ "x-inky-api-key": TEST_KEY, "x-inky-region": "us" }, pinned);
    expect(r.ok).toBe(false);
  });
});

describe("log redaction", () => {
  it("masks INKY keys and drops credential-named fields", () => {
    const out = redact({ apiKey: TEST_KEY, headers: { "X-API-Key": TEST_KEY }, note: `used ${TEST_KEY}`, nested: [{ secret: "s" }] });
    const text = JSON.stringify(out);
    expect(text).not.toContain(TEST_KEY);
    expect(text).toContain("inky_ext_TESTKEY");
    expect(text).toContain("[redacted]");
  });
});
