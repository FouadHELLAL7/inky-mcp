#!/usr/bin/env node
/**
 * End-to-end MCP smoke test against a local mock of the INKY API.
 *
 * Starts the server over stdio and over Streamable HTTP (gateway mode), and
 * with the official MCP SDK client: initialize -> tools/list -> tools/call
 * (inky_test_connection, inky_teams_list, inky_messages_search, inky_status).
 * Also checks /health and that /mcp refuses requests without X-Gateway-S2S.
 *
 *   node scripts/smoke-mcp.mjs                 # runs node dist/index.js
 *   node scripts/smoke-mcp.mjs --docker IMAGE  # runs the container image (Linux, --network host)
 *
 * The server reaches the mock through INKY_TEST_BASE_URL, which the server
 * only accepts for http loopback origins. No real INKY API is contacted
 * except GET /v1/status from inky_status, which needs no key.
 */
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const dockerImage = args[0] === "--docker" ? args[1] : undefined;
const EXPECTED_TOOLS = 24;
const STDIO_KEY = "inky_ext_SMOKESTDIO0000000000000000000000aaaaaa";
const HTTP_KEY = "inky_ext_SMOKEHTTP00000000000000000000000bbbbbb";
const S2S_SECRET = randomBytes(32).toString("hex");
const BEARER = randomBytes(32).toString("hex");

const seenKeys = [];
let failures = 0;

function check(label, condition, detail = "") {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

function sign(secret) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`t=${t}`).digest("hex")}`;
}

function startMockInky() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const key = req.headers["x-api-key"];
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "x-request-id": "smoke-req", "x-ratelimit-remaining": "99" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/v1/status") return send(200, { status: "ok" });
    if (!key) return send(401, { error: { code: "MISSING_API_KEY", message: "No X-API-Key header" } });
    seenKeys.push(key);
    if (url.pathname === "/v1/me") {
      return send(200, { teamid: "$smoke", key_prefix: String(key).slice(0, 16), key_type: "custom", scope_type: "org", permissions: { api_access: ["read"], messages: ["read"] }, status: "active", expires_at: null });
    }
    if (url.pathname === "/v1/teams") {
      return send(200, { teams: [{ team_id: "smoke-team", teamid: "smoke-team", kind: "team", parent_teamid: "$smoke", team_label: "Smoke Co", disabled: false, created_at: "", domains: ["smoke.example"] }], pagination: { next_cursor: null, limit: 50 } });
    }
    if (url.pathname === "/beta/teams/smoke-team/messages") {
      return send(200, {
        messages: [{ team_id: "smoke-team", mailbox: "pat@smoke.example", rfc822_message_id: "abc@x", received_at: "2026-11-10T10:00:00.000Z", subject: "Invoice", sender: { email: "bad@evil.example", display_name: "Billing", domain: "evil.example" }, recipients: ["pat@smoke.example"], threat_level: "danger", reasons: [{ code: "brand_impersonation", label: "Brand Impersonation" }], delivery_target: "junk", direction: "inbound", has_attachments: false, link_count: 1, reports: { open: 0, confirmed: 0, rejected: 0 } }],
        pagination: { next_cursor: null, limit: 25 },
      });
    }
    return send(404, { error: { code: "NOT_FOUND", message: "not mocked" } });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function exercise(client, label) {
  const tools = await client.listTools();
  check(`${label}: tools/list returns ${EXPECTED_TOOLS} tools`, tools.tools.length === EXPECTED_TOOLS, `(got ${tools.tools.length})`);
  check(`${label}: every tool is annotated read-only`, tools.tools.every((t) => t.annotations?.readOnlyHint === true));
  for (const [name, toolArgs, expectText] of [
    ["inky_test_connection", {}, "$smoke"],
    ["inky_teams_list", {}, "smoke-team"],
    ["inky_messages_search", { team_id: "smoke-team", threat_level: "danger" }, "brand_impersonation"],
  ]) {
    const result = await client.callTool({ name, arguments: toolArgs });
    const text = result.content?.[0]?.text ?? "";
    check(`${label}: tools/call ${name}`, !result.isError && text.includes(expectText), text.slice(0, 200));
  }
  const bad = await client.callTool({ name: "inky_raw_request", arguments: { path: "https://evil.example/v1/me" } });
  check(`${label}: raw request refuses absolute URLs`, bad.isError === true);
}

function serverCommand(env, { interactive, detached } = {}) {
  if (!dockerImage) return { command: process.execPath, args: ["dist/index.js"], env: { ...process.env, ...env } };
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const flags = ["run", "--rm", "--network", "host", ...(interactive ? ["-i"] : []), ...(detached ? ["-d"] : [])];
  return { command: "docker", args: [...flags, ...envArgs, dockerImage, "node", "dist/index.js"], env: process.env };
}

async function main() {
  const mock = await startMockInky();
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;
  console.log(`Mock INKY API on ${mockUrl}${dockerImage ? `; server image ${dockerImage}` : "; server node dist/index.js"}`);

  // ---- stdio ----
  console.log("stdio transport");
  const stdio = serverCommand({ MCP_TRANSPORT: "stdio", INKY_API_KEY: STDIO_KEY, INKY_TEST_BASE_URL: mockUrl, LOG_LEVEL: "warn" }, { interactive: true });
  const stdioClient = new Client({ name: "inky-smoke", version: "1.0.0" });
  await stdioClient.connect(new StdioClientTransport({ command: stdio.command, args: stdio.args, env: stdio.env, stderr: "inherit" }));
  check("stdio: initialize", stdioClient.getServerVersion()?.name === "inky-mcp");
  await exercise(stdioClient, "stdio");
  await stdioClient.close();
  check("stdio: upstream calls carried the stdio key", seenKeys.length > 0 && seenKeys.every((k) => k === STDIO_KEY));
  seenKeys.length = 0;

  // ---- Streamable HTTP, gateway mode ----
  console.log("Streamable HTTP transport (AUTH_MODE=gateway)");
  const port = await freePort();
  const httpEnv = { MCP_TRANSPORT: "http", MCP_HTTP_PORT: String(port), MCP_HTTP_HOST: "127.0.0.1", AUTH_MODE: "gateway", CONDUIT_S2S_SECRET: S2S_SECRET, MCP_BEARER_TOKEN: BEARER, INKY_TEST_BASE_URL: mockUrl, LOG_LEVEL: "warn" };
  const http = serverCommand(httpEnv, { detached: Boolean(dockerImage) });
  const child = spawn(http.command, http.args, { env: http.env, stdio: ["ignore", dockerImage ? "pipe" : "inherit", "inherit"] });
  let containerId = "";
  if (dockerImage) child.stdout.on("data", (d) => (containerId += d.toString()));
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    try {
      const res = await fetch(`${base}/health`);
      healthy = res.ok;
      if (healthy) {
        const body = await res.json();
        check("http: /health responds ok", body.status === "ok" && body.authMode === "gateway");
        check("http: /health exposes no secrets", !JSON.stringify(body).includes(S2S_SECRET));
      }
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  check("http: server became healthy", healthy);
  if (healthy) {
    const unsigned = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check("http: /mcp without X-Gateway-S2S is 401", unsigned.status === 401);
    const noKey = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", "x-gateway-s2s": sign(S2S_SECRET) }, body: "{}" });
    check("http: gateway mode without X-Inky-Api-Key is 401", noKey.status === 401);

    const httpClient = new Client({ name: "inky-smoke", version: "1.0.0" });
    await httpClient.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { "x-gateway-s2s": sign(S2S_SECRET), "x-inky-api-key": HTTP_KEY, "x-inky-region": "eu" } },
      }),
    );
    check("http: initialize", httpClient.getServerVersion()?.name === "inky-mcp");
    await exercise(httpClient, "http");
    await httpClient.close();
    check("http: upstream calls carried the gateway header key", seenKeys.length > 0 && seenKeys.every((k) => k === HTTP_KEY));

    const wrongBearer = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong", "x-inky-api-key": HTTP_KEY }, body: "{}" });
    check("http: wrong bearer token is 401", wrongBearer.status === 401);
    const bearerClient = new Client({ name: "inky-smoke-bearer", version: "1.0.0" });
    await bearerClient.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${BEARER}`, "x-inky-api-key": HTTP_KEY, "x-inky-region": "eu" } },
      }),
    );
    const viaBearer = await bearerClient.callTool({ name: "inky_teams_list", arguments: {} });
    check("http: static bearer token gateway auth works", !viaBearer.isError && (viaBearer.content?.[0]?.text ?? "").includes("smoke-team"));
    await bearerClient.close();
  }

  if (dockerImage) {
    await new Promise((r) => setTimeout(r, 200));
    spawn("docker", ["rm", "-f", containerId.trim()], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
  mock.close();
  console.log(failures === 0 ? "SMOKE PASSED" : `SMOKE FAILED (${failures} failures)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
