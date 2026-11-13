import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { StartupError, resolveBindHost, resolveHttpAuth, resolveS2sSecret, startHttpServer, verifyBearer } from "../src/http.js";
import { signS2sHeader, verifyS2sHeader } from "../src/s2s-verify.js";
import { json, mockFetch } from "./helpers.js";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_A = "inky_ext_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaaaaaa";
const KEY_B = "inky_ext_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBbbbbbb";

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

async function start(env: NodeJS.ProcessEnv, route: Parameters<typeof mockFetch>[0] = () => json({})) {
  const mock = mockFetch(route);
  const server = await startHttpServer({
    config: loadConfig(env),
    env: { MCP_HTTP_PORT: "0", CONDUIT_S2S_SECRET: SECRET, ...env },
    clientDeps: { fetch: mock.fetch, sleep: async () => undefined },
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, requests: mock.requests };
}

async function mcpClient(base: string, headers: Record<string, string>) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } });
  const client = new Client({ name: "http-test", version: "0" });
  await client.connect(transport);
  return client;
}

describe("startup guards", () => {
  it("fails closed without a real S2S secret", () => {
    expect(() => resolveS2sSecret({})).toThrow(StartupError);
    expect(() => resolveS2sSecret({ CONDUIT_S2S_SECRET: "changeme" })).toThrow(StartupError);
    expect(() => resolveS2sSecret({ CONDUIT_S2S_SECRET: "changeme", MCP_ALLOW_INSECURE_DEV: "1" })).toThrow(StartupError);
    expect(resolveS2sSecret({ MCP_ALLOW_INSECURE_DEV: "1" })).toEqual({ secret: "", insecureDev: true });
  });

  it("insecure dev mode binds loopback only", () => {
    expect(resolveBindHost(true, {})).toBe("127.0.0.1");
    expect(() => resolveBindHost(true, { MCP_HTTP_HOST: "0.0.0.0" })).toThrow(StartupError);
    expect(resolveBindHost(false, { MCP_HTTP_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });

  it("verifies S2S signatures with skew and tamper checks", () => {
    expect(verifyS2sHeader(signS2sHeader(SECRET), SECRET)).toBe(true);
    expect(verifyS2sHeader(signS2sHeader("other-secret"), SECRET)).toBe(false);
    expect(verifyS2sHeader(signS2sHeader(SECRET, Math.floor(Date.now() / 1000) - 3600), SECRET)).toBe(false);
    expect(verifyS2sHeader("garbage", SECRET)).toBe(false);
  });
});

describe("HTTP endpoints", () => {
  it("/health is unauthenticated and exposes no secrets", async () => {
    const { base } = await start({ AUTH_MODE: "gateway", INKY_API_KEY: KEY_A });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", transport: "http", authMode: "gateway" });
    const text = JSON.stringify(body);
    expect(text).not.toContain(KEY_A);
    expect(text).not.toContain(SECRET);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("rejects /mcp without a valid X-Gateway-S2S header", async () => {
    const { base, requests } = await start({ AUTH_MODE: "gateway" });
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", "x-inky-api-key": KEY_A }, body: "{}" });
    expect(res.status).toBe(401);
    expect(requests).toHaveLength(0);
  });

  it("rejects non-POST methods on /mcp", async () => {
    const { base } = await start({ AUTH_MODE: "gateway" });
    const res = await fetch(`${base}/mcp`, { method: "GET", headers: { "x-gateway-s2s": signS2sHeader(SECRET) } });
    expect(res.status).toBe(405);
  });

  it("gateway mode requires X-Inky-Api-Key and never falls back to INKY_API_KEY", async () => {
    const { base, requests } = await start({ AUTH_MODE: "gateway", INKY_API_KEY: KEY_A });
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-gateway-s2s": signS2sHeader(SECRET) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).toContain("X-Inky-Api-Key");
    expect(requests).toHaveLength(0);
  });

  it("rejects an invalid X-Inky-Region with 400", async () => {
    const { base } = await start({ AUTH_MODE: "gateway" });
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-s2s": signS2sHeader(SECRET), "x-inky-api-key": KEY_A, "x-inky-region": "evil.example" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("serves MCP initialize, tools/list and tools/call over Streamable HTTP", async () => {
    const { base, requests } = await start({ AUTH_MODE: "gateway" }, () => json({ teams: [], pagination: { next_cursor: null, limit: 50 } }));
    const client = await mcpClient(base, { "x-gateway-s2s": signS2sHeader(SECRET), "x-inky-api-key": KEY_A, "x-inky-region": "eu" });
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(24);
    const result = await client.callTool({ name: "inky_teams_list", arguments: { limit: 5 } });
    expect(result.isError).toBeFalsy();
    expect(requests[0].url.origin).toBe("https://api.eu.inkyphishfence.com");
    expect(requests[0].headers["x-api-key"]).toBe(KEY_A);
    await client.close();
  });
});

describe("static bearer token gateway auth", () => {
  const TOKEN = "b".repeat(16) + "0123456789abcdef";

  it("validates MCP_BEARER_TOKEN at startup", () => {
    expect(() => resolveHttpAuth({ MCP_BEARER_TOKEN: "short" })).toThrow(StartupError);
    expect(() => resolveHttpAuth({ MCP_BEARER_TOKEN: "changeme" })).toThrow(StartupError);
    expect(resolveHttpAuth({ MCP_BEARER_TOKEN: TOKEN })).toMatchObject({ bearerToken: TOKEN, s2sSecret: "", insecureDev: false });
    expect(verifyBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(verifyBearer(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(verifyBearer(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(verifyBearer(TOKEN, TOKEN)).toBe(false);
  });

  it("accepts Authorization: Bearer with gateway credential headers and rejects a wrong token", async () => {
    const { base, requests } = await start({ CONDUIT_S2S_SECRET: "", MCP_BEARER_TOKEN: TOKEN, AUTH_MODE: "gateway" }, () => json({ teams: [], pagination: { next_cursor: null, limit: 50 } }));
    const wrong = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope", "x-inky-api-key": KEY_A }, body: "{}" });
    expect(wrong.status).toBe(401);
    const s2sOnly = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", "x-gateway-s2s": signS2sHeader(SECRET), "x-inky-api-key": KEY_A }, body: "{}" });
    expect(s2sOnly.status).toBe(401);
    const client = await mcpClient(base, { authorization: `Bearer ${TOKEN}`, "x-inky-api-key": KEY_A, "x-inky-region": "eu" });
    const result = await client.callTool({ name: "inky_teams_list", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(requests[0].headers["x-api-key"]).toBe(KEY_A);
    expect(requests[0].headers.authorization).toBeUndefined();
    await client.close();
  });
});

describe("gateway credential isolation", () => {
  it("keeps concurrent callers' keys and regions separate", async () => {
    // The mock answers each request after a delay that depends on the key, so
    // the two callers' tool calls interleave inside the server.
    const { base, requests } = await start({ AUTH_MODE: "gateway" }, async (_url, req) => {
      await new Promise((r) => setTimeout(r, req.headers["x-api-key"] === KEY_A ? 60 : 5));
      return json({ teams: [{ team_id: req.headers["x-api-key"] === KEY_A ? "team-a" : "team-b", kind: "team", parent_teamid: null, team_label: null, disabled: false, created_at: "", domains: [] }], pagination: { next_cursor: null, limit: 50 } });
    });
    const a = await mcpClient(base, { "x-gateway-s2s": signS2sHeader(SECRET), "x-inky-api-key": KEY_A, "x-inky-region": "eu" });
    const b = await mcpClient(base, { "x-gateway-s2s": signS2sHeader(SECRET), "x-inky-api-key": KEY_B, "x-inky-region": "us" });

    const calls = await Promise.all([
      ...Array.from({ length: 5 }, () => a.callTool({ name: "inky_teams_list", arguments: {} })),
      ...Array.from({ length: 5 }, () => b.callTool({ name: "inky_teams_list", arguments: {} })),
    ]);
    const texts = calls.map((c) => (c.content as Array<{ text: string }>)[0].text);
    expect(texts.slice(0, 5).every((t) => t.includes("team-a") && !t.includes("team-b"))).toBe(true);
    expect(texts.slice(5).every((t) => t.includes("team-b") && !t.includes("team-a"))).toBe(true);

    const upstream = requests.filter((r) => r.url.pathname === "/v1/teams");
    expect(upstream).toHaveLength(10);
    for (const r of upstream) {
      if (r.headers["x-api-key"] === KEY_A) expect(r.url.origin).toBe("https://api.eu.inkyphishfence.com");
      else {
        expect(r.headers["x-api-key"]).toBe(KEY_B);
        expect(r.url.origin).toBe("https://api.inkyphishfence.com");
      }
    }
    await a.close();
    await b.close();
  });

  it("env mode over HTTP uses INKY_API_KEY from the environment", async () => {
    const { base, requests } = await start({ AUTH_MODE: "env", INKY_API_KEY: KEY_B, INKY_REGION: "eu" }, () => json({ teams: [], pagination: { next_cursor: null, limit: 50 } }));
    const client = await mcpClient(base, { "x-gateway-s2s": signS2sHeader(SECRET) });
    await client.callTool({ name: "inky_teams_list", arguments: {} });
    expect(requests[0].headers["x-api-key"]).toBe(KEY_B);
    await client.close();
  });
});
