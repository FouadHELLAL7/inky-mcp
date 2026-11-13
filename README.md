# INKY MCP Server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for the **INKY email security External API**. It is built for everyday MSP email-security work: finding a customer's INKY team, searching what a mailbox received, explaining why a message was delivered or junked, reviewing user-reported mail, auditing allow/block lists, VIPs and console admins, and summarising threat trends for client reports.

It follows the conventions of the [WYRE-AI MSP MCP servers](https://github.com/WYRE-AI) (Autotask, IT Glue, Datto RMM, Huntress): the same `MCP_TRANSPORT` / `AUTH_MODE` settings, a stateless Streamable HTTP endpoint at `/mcp` on port 8080, `/health`, per-request gateway credentials and logs on stderr. See [docs/REFERENCE_NOTES.md](docs/REFERENCE_NOTES.md).

> **Status:** 1.0.0, unreleased. Every tool has been tested against a mocked INKY API that follows the documented response shapes. No live INKY tenant has been queried yet (see [Live checks still required](#live-checks-still-required)). No npm package, GHCR image or registry entry has been published.

## What it covers

Verified against the INKY External API **1.15.0** OpenAPI document and the authenticated developer portal ([docs/API_NOTES.md](docs/API_NOTES.md)).

| Area | Tools | INKY API | Stability |
|---|---|---|---|
| Connection | `inky_status`, `inky_test_connection`, `inky_navigate` | `/v1/status`, `/v1/me` | stable |
| Teams / tenants | `inky_teams_list`, `inky_teams_find`, `inky_teams_get` | `/v1/teams` | stable |
| Billable usage | `inky_usage_get`, `inky_usage_history` | `/v1/usage` | stable |
| Message search | `inky_messages_search` | `/beta/teams/{team_id}/messages` | beta |
| Threat statistics | `inky_statistics_get`, `inky_threat_summary` | `/beta/teams/{team_id}/statistics[/reasons\|/result_categories]` | beta |
| Reported mail | `inky_reported_mail_list`, `inky_reported_mail_get`, `inky_reported_mail_item_actions` | `/beta/reported_mail`, `/beta/teams/{team_id}/reported_mail/…` | beta |
| Allow / block lists | `inky_allow_list_list`, `inky_allow_list_get`, `inky_block_list_list`, `inky_block_list_get` | `/beta/allow_list`, `/beta/block_list` | beta |
| VIPs | `inky_vips_list`, `inky_vips_get` | `/beta/vips` | beta |
| Console admins | `inky_admins_list`, `inky_admins_get` | `/beta/admins` | beta |
| Reference | `inky_result_types_list` | `/beta/result_types` | beta |
| Escape hatch | `inky_raw_request` (GET only, documented endpoints only) | any documented GET | — |

INKY's `/beta` endpoints are fully documented but "may change shape or be removed without notice". The server is **read-only**: none of INKY's documented write operations (creating rules, remediating reported mail, managing VIPs/admins) are exposed. See [Write tools](#write-tools).

**Not available from the INKY API** (so not offered here): message bodies or attachment downloads, quarantine release, free-text/subject search, outbound mail, webhooks, estate-wide statistics. Details in [docs/API_NOTES.md §8](docs/API_NOTES.md#8-not-available-in-the-api).

## Prerequisites

- Node.js 22 or later (or Docker).
- An **INKY API key**, created in the INKY console under **Settings → API Keys** by a **Super Admin** on the team or organization the key should reach. The key (`inky_ext_…`) is shown once.
  - **Scope:** create the key with your MSP organization selected to reach every customer team beneath it.
  - **Permissions:** the default key reads teams and usage only. Choose **Custom** and tick `read` for the families you want: Messages, Statistics, Reported Mail, Allow List, Block List, VIP List, Admins. `inky_reported_mail_item_actions` also needs Reported Mail `remediate` (INKY gates that preview with the write permission). Management families need an active Kaseya relationship on the INKY account.
  - Run `inky_test_connection` to see what the key can do.
- Your **region**. INKY runs separate EU and US platforms and a key only works in its own region:

| Region | API base URL | Developer portal |
|---|---|---|
| `eu` | `https://api.eu.inkyphishfence.com` | `https://docs.eu.inkyphishfence.com` |
| `us` | `https://api.inkyphishfence.com` | `https://docs.inkyphishfence.com` |

The server only ever sends the key to one of these two origins. Partner HMAC request signing (only for INKY `_integration` partner keys) is not implemented; console-issued keys do not need it.

## Install

```bash
git clone https://github.com/FouadHELLAL7/inky-mcp.git
cd inky-mcp
npm ci
npm run build
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `INKY_API_KEY` | — | INKY API key. Used by stdio and by HTTP with `AUTH_MODE=env`. Ignored in gateway mode. |
| `INKY_REGION` | `us` | `eu` or `us`. In gateway mode: the default when a request has no `X-Inky-Region` header. |
| `INKY_API_BASE_URL` | — | Alternative to `INKY_REGION`; must be exactly one of the two origins above. |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http`. |
| `AUTH_MODE` | `env` | HTTP only. `env`: `INKY_API_KEY` from the environment. `gateway`: credentials from request headers, no environment fallback. |
| `MCP_HTTP_PORT` / `PORT` | `8080` | HTTP port (`MCP_HTTP_PORT` wins). |
| `MCP_HTTP_HOST` | `127.0.0.1` | HTTP bind address (the Docker image sets `0.0.0.0`). |
| `CONDUIT_S2S_SECRET` | — | HTTP gateway auth, WYRE conduit style: every `/mcp` request needs a valid signed `X-Gateway-S2S` header. |
| `MCP_BEARER_TOKEN` | — | HTTP gateway auth for gateways that send fixed headers: every `/mcp` request needs `Authorization: Bearer <token>` (≥ 24 chars). |
| `MCP_ALLOW_INSECURE_DEV` | — | `1` = start HTTP with neither secret, loopback only. Local development only. |
| `INKY_TIMEOUT_MS` | `30000` | Per-request timeout. |
| `INKY_MAX_RETRIES` | `2` | Retries for 429 / 500 / 502–504 and network errors (GET only). |
| `INKY_MAX_RETRY_WAIT_SECONDS` | `30` | Longest `Retry-After` the server will wait; longer waits are returned as an error with `retry_after_seconds`. |
| `INKY_MAX_RESPONSE_BYTES` | `5242880` | Largest INKY response body read. |
| `INKY_MAX_OUTPUT_CHARS` | `60000` | Largest tool result; larger results drop rows from the main list and say so. |
| `INKY_ENABLE_RAW_REQUEST` | `true` | Set `false` to hide `inky_raw_request`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. All logs go to stderr. |

HTTP refuses to start unless `CONDUIT_S2S_SECRET` or `MCP_BEARER_TOKEN` is set (or `MCP_ALLOW_INSECURE_DEV=1`). Known placeholder values are always refused. See [.env.example](.env.example).

## Claude Code

```bash
claude mcp add inky -e INKY_API_KEY=inky_ext_your_key -e INKY_REGION=eu -- node /path/to/inky-mcp/dist/index.js
```

## Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "inky": {
      "command": "node",
      "args": ["/path/to/inky-mcp/dist/index.js"],
      "env": {
        "INKY_API_KEY": "inky_ext_your_key",
        "INKY_REGION": "eu"
      }
    }
  }
}
```

An MCP Bundle can be built with `npm run pack:mcpb` (manifest validated with `mcpb validate`); it prompts for the key and region.

## Docker

Build:

```bash
docker build -t inky-mcp .
```

stdio (single user, key from the environment):

```bash
docker run -i --rm -e MCP_TRANSPORT=stdio -e INKY_API_KEY=inky_ext_your_key -e INKY_REGION=eu inky-mcp
```

HTTP, gateway mode (the image default; credentials come from each request):

```bash
docker run -d --name inky-mcp -p 127.0.0.1:8080:8080 \
  -e MCP_BEARER_TOKEN="$(openssl rand -hex 32)" \
  -e INKY_REGION=eu \
  inky-mcp
curl http://127.0.0.1:8080/health
```

HTTP, env mode (one shared key in the container):

```bash
docker run -d --name inky-mcp -p 127.0.0.1:8080:8080 \
  -e AUTH_MODE=env -e INKY_API_KEY=inky_ext_your_key -e INKY_REGION=eu \
  -e MCP_BEARER_TOKEN="$(openssl rand -hex 32)" \
  inky-mcp
```

`docker compose up -d` runs the gateway-mode service from [docker-compose.yml](docker-compose.yml) (put `MCP_BEARER_TOKEN` or `CONDUIT_S2S_SECRET` in `.env`).

`/health` (and `/healthz`) returns `{"status":"ok","server":"inky-mcp","version":"1.0.0","transport":"http","authMode":"gateway","timestamp":…}`. It needs no credentials and contains no secrets or tenant data.

## Gateway setup

In gateway mode (`MCP_TRANSPORT=http`, `AUTH_MODE=gateway`) the gateway sends, on **every** `POST /mcp`:

| Header | Required | Value |
|---|---|---|
| `X-Inky-Api-Key` | yes | The INKY API key (`inky_ext_…`). Sent to INKY as `X-API-Key`. |
| `X-Inky-Region` | no | `eu` or `us`; defaults to the container's `INKY_REGION`. Anything else is rejected with 400. |
| `X-Gateway-S2S` | if `CONDUIT_S2S_SECRET` is set | `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "t=<t>")>`, max 300 s skew (WYRE conduit). |
| `Authorization` | if `MCP_BEARER_TOKEN` is set | `Bearer <MCP_BEARER_TOKEN>` |

If both secrets are configured, either check is accepted. Missing gateway authentication returns 401 before anything else. A missing `X-Inky-Api-Key` returns 401 `{"error":"Missing credentials","required":["X-Inky-Api-Key"]}`; the environment key is never used as a fallback. Each request gets its own MCP server instance with that request's credentials, so concurrent callers with different keys or regions never share state (covered by `test/http.test.ts`).

### Adding it next to Autotask, IT Glue and Datto RMM

1. Run the container on the same Docker network as your other MCP servers, named `inky-mcp`, with `MCP_BEARER_TOKEN` (or `CONDUIT_S2S_SECRET` for a WYRE conduit gateway) and `INKY_REGION=eu`.
2. Store the INKY API key and the bearer token in the gateway's secret store.
3. Add an HTTP upstream:
   - id / namespace: `inky`
   - URL: `http://inky-mcp:8080/mcp`
   - headers (secret references, never raw values):
     - `Authorization: Bearer <reference to the MCP_BEARER_TOKEN secret>`
     - `X-Inky-Api-Key: <reference to the INKY API key secret>`
     - `X-Inky-Region: eu`
4. Refresh the catalog. All 24 tools are read-only (`readOnlyHint: true`), so viewer-level grants are appropriate.

Alternatively run the container with `AUTH_MODE=env` and `INKY_API_KEY` set, like a single-tenant upstream, and only send the `Authorization` header from the gateway.

## Tools and example calls

All tools return JSON text. Lists return `returned`, `has_more` and `next_cursor`. Pass `next_cursor` back as `cursor` to the **same tool with the same filters** to get the next page; a `null` `next_cursor` is the end.

| Tool | Purpose | Example arguments |
|---|---|---|
| `inky_test_connection` | Key scope, permissions, rotation/expiry, rate-limit headers | `{}` |
| `inky_status` | Region, origin, key configured?, INKY reachability | `{}` |
| `inky_navigate` | Tools grouped by domain | `{"domain":"messages"}` |
| `inky_teams_find` | Resolve a customer by name or domain | `{"query":"acme.com"}` |
| `inky_teams_list` / `inky_teams_get` | Estate tree (`kind`, `parent_team_id`, domains) | `{"limit":200}` |
| `inky_messages_search` | What did this mailbox receive and what did INKY decide? | `{"team_id":"$msp","recipient":"pat@acme.com","since":"2026-11-01T00:00:00Z"}` |
| | Find every copy of a reported or SIEM message | `{"team_id":"$msp","rfc822_message_id":"<CAE1abc@mail.example>","detail":true}` |
| | Dangerous mail that reached the inbox | `{"team_id":"acme","threat_level":"danger","delivery_target":"inbox"}` |
| `inky_threat_summary` | Monthly client report: verdict split, peak days, top reasons | `{"team_id":"acme","since":"2026-10-01","until":"2026-10-31"}` |
| `inky_statistics_get` | Daily counts by verdict, reason or result category | `{"team_id":"acme","breakdown":"reason"}` |
| `inky_reported_mail_list` | Open user-reported mail, newest first | `{"severity":"high"}` |
| | What happened to this message? (includes closed records) | `{"rfc822_message_id":"CAE1abc@mail.example"}` |
| `inky_reported_mail_get` | Full record with items and user reports | `{"team_id":"acme","record_id":"<uuid>"}` |
| `inky_reported_mail_item_actions` | Preview allow/block rules INKY would create (no changes) | `{"team_id":"acme","record_id":"<uuid>","item_id":"<uuid>"}` |
| `inky_allow_list_list` | Allow-anything rules across the estate | `{"result_type":"*","enabled":true}` |
| | Why was this sender allowed for one team (incl. inherited)? | `{"team_id":"acme","sender":"vendor.example"}` |
| `inky_block_list_list` | Block rules for a domain | `{"from_domain":"spam.example"}` |
| `inky_vips_list` / `inky_admins_list` | VIP and console-admin audits | `{"team_id":"acme"}` |
| `inky_result_types_list` | Verdict codes ↔ console labels | `{"list":"allow"}` |
| `inky_usage_get` / `inky_usage_history` | Billable mailboxes, license reconciliation | `{"days":30}` |
| `inky_raw_request` | GET any documented endpoint | `{"path":"/beta/teams/acme/statistics/result_categories","query":{"since":"2026-10-01"}}` |

Typical investigation: `inky_teams_find` → `inky_messages_search` (recipient + window) → `detail=true` on the suspicious copy → `inky_allow_list_list` with `team_id` to see whether a rule let it through → `inky_reported_mail_list` with its `rfc822_message_id`.

### `inky_raw_request` safety

GET only. `path` must be relative and match one of the 27 documented INKY GET templates (writes such as `:remediate` or `:batch` cannot match). Scheme/host, `//`, `..`, backslashes, query strings or fragments in `path`, encoded `/` or `.`, and double encoding are rejected before any request. Dynamic segments are decoded once and re-encoded, the final URL is checked against the configured INKY origin, redirects are never followed, and the caller's own key, timeout, retry and size limits apply.

## Pagination, rate limits and errors

- **Page sizes:** teams, usage, allow/block, VIPs, admins: 1–999 (INKY default 50). Messages and reported mail: 1–100 (default 25). Statistics return the whole window (≤ 90 days) without paging.
- **Windows:** message search defaults to the last 7 days, at most 90 days per call. Statistics cover closed UTC days (default the last 30 ending yesterday, at most 179 days back). Reported mail defaults to 7 days of activity.
- **Rate limits** are per INKY node plus an organization-wide budget, with no published numbers. On `429 RATE_LIMITED` (and 500/503) the server waits `Retry-After` and retries up to `INKY_MAX_RETRIES` times. Waits longer than `INKY_MAX_RETRY_WAIT_SECONDS` are returned to the model instead. `POLLED_TOO_SOON` (re-reading the same reported-mail first page within 60 s) is never retried; pass the previous `poll_from` as `updated_since` instead.
- **Errors** come back as `isError` results with INKY's `code`, HTTP status, `request_id` (quote it to INKY support) and guidance. Examples: `INVALID_API_KEY` (wrong region?), `FORBIDDEN` (permission missing, check `inky_test_connection`), `NOT_FOUND` (absent or outside the key's scope).
- **Output:** long text fields are clipped, embedded lists are capped (e.g. 25 links per message), and results over `INKY_MAX_OUTPUT_CHARS` drop trailing rows with an `output_truncated` note.
- **Privacy:** keys, cookies and authorization headers are never logged or returned. INKY keys in error text are masked to their 16-character prefix, and message content is never logged.

## Write tools

None. INKY documents write endpoints (allow/block rule create/modify/delete, VIP and admin management, reported-mail remediate/dismiss/review/apply). All of them are `/beta` and change mail-flow policy or console access across customer estates. Adding them would be a separate, opt-in change behind `INKY_ENABLE_WRITE_TOOLS=true`, with destructive annotations and testing against a non-production tenant first.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `INVALID_API_KEY` on every call | Key and region don't match (`INKY_REGION` / `X-Inky-Region`), or the key was revoked/rotated. |
| `FORBIDDEN` on messages/statistics/lists | Add that family's `read` permission to the key in the INKY console (no new key needed), then rerun `inky_test_connection`. |
| `NOT_ENTITLED` | The INKY account lacks the Kaseya relationship needed for management families. Contact INKY. |
| `422` on statistics | `team_id` is an organization node; statistics are per team. |
| `POLLED_TOO_SOON` | Use `updated_since` = previous `poll_from` instead of re-reading. |
| HTTP server exits at start | Set `CONDUIT_S2S_SECRET` or `MCP_BEARER_TOKEN` (real random values), or `MCP_ALLOW_INSECURE_DEV=1` locally. |
| Gateway gets 401 | Check the `Authorization`/`X-Gateway-S2S` header and `X-Inky-Api-Key`. |
| stdio client shows garbage | Nothing in this server writes to stdout except JSON-RPC; check wrappers. |

## Development

```bash
npm run lint        # eslint
npm run typecheck   # tsc incl. tests
npm test            # vitest (mocked INKY API)
npm run build
npm run smoke       # MCP SDK client over stdio and HTTP against a mock INKY API
npm run spec:fetch  # download INKY's OpenAPI document to openapi/ (git-ignored)
```

CI (`.github/workflows/ci.yml`) runs all of the above on Node 22 and 24, builds the Docker image and runs the smoke test against the container over stdio and HTTP. The release workflow is manual-only and pushes to GHCR only when dispatched with `confirm: publish`.

## Live checks still required

Built without access to an INKY API key. Mocked tests cover request construction, errors, retries, pagination, tools and gateway isolation; only the unauthenticated `GET /v1/status` was called live (EU and US). Before relying on it, run with a real key:

1. `inky_test_connection` in each region you use (confirms auth header and `/v1/me` shape).
2. `inky_teams_list` / `inky_teams_find` on an organization-scoped key.
3. `inky_messages_search` with an org node `team_id` and with `detail=true`.
4. `inky_threat_summary` on a team; `inky_statistics_get` with an org node (expect 422).
5. `inky_reported_mail_list` twice within 60 s (expect `POLLED_TOO_SOON` explained).
6. `inky_allow_list_list` / `inky_block_list_list` with and without `team_id`.
7. `inky_vips_list`, `inky_admins_list`, `inky_result_types_list`, `inky_usage_history`.
8. Rate-limit headers and `X-API-Key-Expires-Soon` surfacing in `inky_test_connection`.
9. The gateway path end to end through your MCP gateway.

## License

Apache-2.0. See [LICENSE](LICENSE).
