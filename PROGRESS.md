# PROGRESS

Last updated: 2026-11-13 (session 1)

## Status

| Milestone | State |
|---|---|
| M1 Reference study (`docs/REFERENCE_NOTES.md`) | done |
| M1 INKY API study from authenticated docs (`docs/API_NOTES.md`) | done |
| M1 Project scaffolding | done |
| M2 API client, config, credentials, stdio + Streamable HTTP transports | done |
| M3 24 read-only tools + mocked tests | done (98 tests) |
| M4 Docker, CI, MCP client smoke verification | done (local + CI) |
| M5 README, packaging metadata (manifest.json, server.json), push | done |

## Validation (all run, all passing)

- `npm run lint`, `npm run typecheck`, `npm test` (98 vitest tests), `npm run build`.
- `npm run smoke`: MCP SDK client against a mock INKY API. stdio: initialize, tools/list (24), tools/call. Streamable HTTP gateway mode: /health, gateway auth required, X-Inky-Api-Key required, S2S and bearer auth paths, tools/call, per-caller key forwarding.
- MCP Inspector CLI 2.15.0 (stdio): tools/list and tools/call `inky_status` (live, unauthenticated `/v1/status`).
- `mcpb validate manifest.json`: passes.
- GitHub Actions CI: on `3e087f6` the Node 22 + 24 test jobs and the Docker job passed (image build, container smoke over stdio and HTTP, refusal to start without a secret). Check the latest run for later commits.

## Decisions

- Auth verified: `X-API-Key`; EU `https://api.eu.inkyphishfence.com`, US `https://api.inkyphishfence.com`. Default region `us` (override `INKY_REGION=eu`). Partner HMAC signing not implemented (not needed for console-issued keys).
- Gateway headers: `X-Inky-Api-Key` (required), `X-Inky-Region` (optional). Gateway auth: `X-Gateway-S2S` (`CONDUIT_S2S_SECRET`) and/or `Authorization: Bearer` (`MCP_BEARER_TOKEN`). The bearer option was added because the user's gateway (v0.20.2) uses static headers.
- Read-only release; INKY's documented `/beta` write endpoints are deliberately not exposed.
- Full vendor OpenAPI spec not committed; `npm run spec:fetch` downloads it.
- Nothing published (no npm, GHCR image or registry entry). The release workflow is manual-only.

## Known issues / remaining work

- **Live API checks outstanding.** No INKY API key was available; see README "Live checks still required".
- Docker is not installed on the build machine; Docker was verified in CI only.
- Optional follow-up: gated write tools (`INKY_ENABLE_WRITE_TOOLS`) after testing on a non-production tenant.
- Adding the server to the user's gateway was not done (it needs the user's approval, secrets and a running container).

## Next step

Deploy the container next to the other MCP servers, add the gateway upstream (README "Gateway setup"), then run the live checks with a real INKY key.
