# PROGRESS

Last updated: 2026-11-13 (session 1)

## Status

| Milestone | State |
|---|---|
| M1 Reference study (`docs/REFERENCE_NOTES.md`) | done |
| M1 INKY API study from authenticated docs (`docs/API_NOTES.md`) | done |
| M1 Project scaffolding (package.json, tsconfig, eslint, vitest) | done |
| M2 API client, config, credentials, HTTP/stdio transports | done |
| M3 Read-only tools (24) + mocked tests (96 passing) | done |
| M4 Docker, CI, MCP client smoke verification | pending |
| M5 README, packaging metadata, final push | pending |

## Decisions

- Auth verified: `X-API-Key` header; regions EU `https://api.eu.inkyphishfence.com`, US `https://api.inkyphishfence.com`. Platform HMAC signing (partner `_integration` keys only) not implemented.
- Gateway headers: `X-Inky-Api-Key` (required), `X-Inky-Region` (optional `eu|us`). Plus WYRE `X-Gateway-S2S`.
- Read-only release; documented `/beta` write endpoints deferred (see `docs/API_NOTES.md` §7).
- Full vendor OpenAPI spec not committed; `npm run spec:fetch` downloads it locally.

## Environment notes

- Docker and `gh` are not installed on the build machine. Docker build/run is verified in GitHub Actions CI instead.
- Git remote pinned to the `FouadHELLAL7` account (`https://FouadHELLAL7@github.com/FouadHELLAL7/inky-mcp.git`).
- No INKY API key available: live API checks outstanding (only unauthenticated `/v1/status` called).

## Next step

Add scripts (smoke test, spec fetch, mcpb pack), Dockerfile, compose, CI, README, packaging metadata.
