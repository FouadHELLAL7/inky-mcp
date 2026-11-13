# WYRE-AI reference notes

Conventions studied from the WYRE-AI MSP MCP servers and mirrored (or deliberately not mirrored) in `inky-mcp`.

Snapshot inspected on 2026-11-13 (shallow clones of `main`):

| Repo | Commit | Date |
|---|---|---|
| WYRE-AI/autotask-mcp | `9d67e25` | 2026-11-12 |
| WYRE-AI/itglue-mcp | `b90ee17` | 2026-10-14 |
| WYRE-AI/datto-rmm-mcp | `d0bd280` | 2026-11-10 |
| WYRE-AI/huntress-mcp | `ac1de03` | 2026-11-04 |
| WYRE-AI/msp-claude-plugins | `main` | — (no INKY plugin exists) |

## 1. Project layout and entry points

| | autotask | itglue | datto-rmm | huntress |
|---|---|---|---|---|
| Module | CommonJS (`tsc`) | ESM, `NodeNext` (`tsc`) | ESM, `NodeNext` (`tsc`) | ESM, `bundler` (`tsup`) |
| Entry | `dist/entry.js` → stdio or http | `dist/index.js` (switches on `MCP_TRANSPORT`) | `dist/index.js` (same) | `dist/index.js` stdio, `dist/http.js` http |
| MCP SDK | `@modelcontextprotocol/server` 2.0 beta + zod 4 | `@modelcontextprotocol/sdk` ^1.31 | `@modelcontextprotocol/sdk` ^1.31 | `@modelcontextprotocol/sdk` ^1.31 |
| Tests | jest | vitest | vitest | vitest |
| Lint | eslint flat | eslint flat (`typescript-eslint`) | eslint flat | `tsc --noEmit` |
| Node engines | >=20 | >=20 | >=20 | >=22 |
| Docker base | `node:26-alpine` (all) | | | |
| TypeScript | ^6.0 (all), `strict: true` | | | |

Typical layout (itglue / datto-rmm / huntress):

```
src/index.ts          transports (stdio + Node HTTP), entry point
src/mcp-server.ts     side-effect-free server factory (huntress: server.ts)
src/domains/*.ts      one module per API domain (huntress)
src/utils/client.ts   request-scoped credentials + client factory
src/utils/logger.ts   stderr logger
src/s2s-verify.ts     gateway service-to-service HMAC check
src/__tests__/*.test.ts
manifest.json         MCPB bundle manifest (manifest_version 0.3)
server.json           MCP registry metadata (io.github.WYRE-AI/<name>)
glama.json            Glama listing
Dockerfile, docker-compose.yml, .env.example, .releaserc.json
scripts/pack-mcpb.cjs, scripts/lint-destructive-warnings.mjs
.github/workflows/{ci|test,release,mcp-assert,claude,add-to-project}.yml
```

Package scripts (common subset): `build`, `dev`, `start`, `test` (`vitest run`), `lint` (`eslint src`), `typecheck` (`tsc --noEmit`), `pack:mcpb`, `validate:mcpb`.

**Chosen for inky-mcp:** ESM + `NodeNext` + `tsc` + vitest + eslint flat config (the itglue / datto-rmm majority), single entry `dist/index.js` that switches on `MCP_TRANSPORT`, huntress-style `src/domains/*` split. Node `>=22`. `@modelcontextprotocol/sdk` ^1.x (3 of 4 repos; autotask's 2.0 beta is not stable).

## 2. Transports

- `MCP_TRANSPORT=stdio` (default) or `http`.
- HTTP: Node `http.createServer`, `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined` and `enableJsonResponse: true` — **stateless**, fresh MCP server + transport per request, closed on `res.close`. itglue rejects non-POST on `/mcp` with 405 JSON-RPC error.
- Port: `MCP_HTTP_PORT` (default `8080`). Bind host: `MCP_HTTP_HOST` (image sets `0.0.0.0`; default loopback in huntress, `0.0.0.0` in itglue when a secret is configured).
- Routes: `/mcp`, `/health` and `/healthz` (unauthenticated liveness; return `{status, transport, authMode|mode, timestamp}`; must not read credentials), everything else 404 with `{error, endpoints}`.
- Statelessness is a **security invariant**: per-request credentials live in `AsyncLocalStorage`; a stateful/SSE transport could serve later messages under a stale credential context.

**Chosen:** identical. The task also names `PORT`; inky-mcp reads `MCP_HTTP_PORT` first and falls back to `PORT`, default 8080.

## 3. Gateway service-to-service auth (all four Node servers)

- `CONDUIT_S2S_SECRET` required to start HTTP. Empty → refuse to start unless `MCP_ALLOW_INSECURE_DEV=1` (then loopback bind only, no S2S check, loud warning). Known placeholder values (`changeme`, `secret`, `your-s2s-secret`, …) always refuse.
- Every `/mcp` request must carry `X-Gateway-S2S: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "t=<t>")>`, max skew 300 s, constant-time compare. Checked **before** credential extraction.

**Chosen:** ported unchanged (`src/s2s-verify.ts`), so the server drops into the same gateway.

**Addition (deviation):** `MCP_BEARER_TOKEN`, a static `Authorization: Bearer` check (constant-time, ≥ 24 characters, placeholders refused), accepted as an alternative to S2S. Reason: the target MCP gateway (v0.20.2, inspected read-only on 2026-11-13) attaches upstreams by URL plus static headers with secret references and does not sign `X-Gateway-S2S`; a time-stamped HMAC cannot be expressed as a static header. Startup still fails closed when neither secret is set.

## 4. Credentials and `AUTH_MODE`

- stdio always reads vendor env vars (`HUNTRESS_API_KEY`, `ITGLUE_API_KEY`, …).
- HTTP: `AUTH_MODE=env` reads env; `AUTH_MODE=gateway` requires per-request headers and **never falls back to env** (CWE-306). Missing headers → HTTP 401 JSON `{error, message, required}` before the MCP layer runs.
- Credentials flow through `AsyncLocalStorage.run()` (huntress) or are passed into the per-request server factory (itglue). Clients are built per call; no process-global singleton holding credentials.

Header naming convention (newer repos): `X-<Vendor>-<Field>` —

| Repo | Headers |
|---|---|
| huntress | `X-Huntress-Api-Key`, `X-Huntress-Api-Secret` |
| itglue | `X-ITGlue-API-Key` (or legacy `X-API-Key`), `X-ITGlue-JWT`, `X-ITGlue-Region`, `X-ITGlue-Base-URL` |
| datto-rmm | `X-Datto-API-Key`, `X-Datto-API-Secret`, `X-Datto-Platform` |
| autotask (older) | `X-API-Key`, `X-API-Secret`, `X-Integration-Code`, `X-API-Url`, `X-Impersonation-Resource-Id` |

Region handling: itglue maps a region enum (`us`/`eu`/`au`) to fixed base URLs and rejects unknown regions with a helpful error. itglue also accepts a free-form `X-ITGlue-Base-URL` header — **not mirrored**: a caller-supplied base URL would let a header send credentials to any host. inky-mcp accepts only an allow-listed region / origin.

**Chosen:** `X-Inky-*` headers, region via allow-list (see `docs/API_NOTES.md` for the INKY-specific credential fields).

## 5. Logging

Huntress `utils/logger.ts`: levelled (`debug|info|warn|error`, `LOG_LEVEL`, default `info`), every line via `console.error` (stderr), so stdio JSON-RPC on stdout is never corrupted. itglue/datto use bare `console.error`. Secrets are never logged (S2S secret explicitly). **Chosen:** huntress logger + a redaction pass on context objects.

## 6. Tools

- Naming: `<vendor>_<domain>_<verb>` snake_case (`huntress_incidents_list`, `itglue_search_organizations`, `autotask_raw_request`).
- Discovery: huntress exposes `huntress_navigate` (list tools per domain) and `huntress_status`; autotask has `autotask_router` / category tools. All tools are still listed up front.
- Schemas: huntress/itglue/datto hand-write JSON Schema `inputSchema`; autotask 2.x uses zod. Validation in handlers is ad hoc in the JSON-schema repos.
- Annotations: `annotations: { title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint }` on tools (itglue, datto, autotask). `scripts/lint-destructive-warnings.mjs` fails CI when a tool whose name contains a destructive verb lacks a `⚠ DESTRUCTIVE` / `⚠ HIGH-IMPACT` description prefix and `destructiveHint: true`.
- Results: `{content:[{type:'text', text: JSON}], isError?}`; huntress `sanitizeResult` guards against `text: undefined`. Errors are returned as `isError: true` results, not thrown JSON-RPC errors.
- Pagination: vendor-specific (huntress `limit` + `page_token`; itglue `page[size]` clamped to `MAX_PAGE_SIZE`; autotask total cap vs per-page size). Common rule: clamp page size, expose the next cursor.
- Raw request: `autotask_raw_request` — method allow-list, `assertSafeRelativePath` (must start with `/`, no `//`, `\`, `://`, `..`), final host assertion against the resolved base. inky-mcp mirrors this but GET-only and stricter (decoded-path checks, query allow-list, no redirects).

**Chosen:** `@modelcontextprotocol/sdk` `McpServer.registerTool` with zod input shapes, so input validation is enforced by the SDK rather than hand-rolled (deviation from the JSON-schema repos; matches autotask's zod direction). Annotations on every tool; `inky_navigate` + `inky_status` discovery tools; destructive-warning lint script kept.

## 7. Packaging and CI

- Dockerfile: multi-stage `node:26-alpine`, `npm ci --ignore-scripts`, build, `npm prune --omit=dev`, non-root user, `apk -U upgrade`, npm removed from runtime, `HEALTHCHECK wget /health`, `ENV MCP_TRANSPORT=http MCP_HTTP_PORT=8080 MCP_HTTP_HOST=0.0.0.0 AUTH_MODE=gateway`, OCI labels, `io.modelcontextprotocol.server.name` label. GitHub Packages auth via BuildKit secret (not needed here: no private deps).
- docker-compose: gateway service, `CONDUIT_S2S_SECRET=${CONDUIT_S2S_SECRET:?…}`, host publish `127.0.0.1:8080:8080`, **no vendor credentials in the gateway service**.
- `.env.example`: placeholders only, documented.
- Workflows: `test.yml`/`ci.yml` (lint, destructive lint, build, test, docker build on PR), `release.yml` (reusable WYRE semantic-release → GHCR → MCP registry pipeline, triggered on push to main), `mcp-assert.yml` (reusable WYRE workflow that boots `dist/index.js` and calls a canary tool), `claude.yml`, `add-to-project.yml`.
- semantic-release with `npmPublish: false`; MCPB bundle via `scripts/pack-mcpb.cjs` + `mcpb validate manifest.json`.
- `server.json` (registry schema 2025-12-11) with OCI package `ghcr.io/wyre-ai/<name>`; `manifest.json` MCPB 0.3 with `user_config` (sensitive fields flagged).

**Chosen:** same Dockerfile/compose shape and metadata files. CI runs lint/test/build/docker build only. Release, GHCR push and registry publish workflows are **not** wired to run automatically (publishing needs separate approval); a manual-only (`workflow_dispatch`) release workflow is provided instead. WYRE org-specific workflows (`claude.yml`, `add-to-project.yml`, reusable WYRE pipelines) are not copied.

## 8. Not carried over

Vendor client libraries, Datto/Huntress endpoints and entities, MCP Apps UI cards (`ui://` resources, vite single-file build) and elicitation helpers, Cloudflare Worker entry (`worker.ts`, `wrangler.json`), DigitalOcean `.do/` template, `.taskmaster/` tooling.
