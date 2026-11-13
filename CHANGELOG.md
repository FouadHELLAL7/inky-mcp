# Changelog

## 1.0.0 (unreleased)

First version. Read-only MCP server for the INKY External API 1.15.0.

- 24 tools: account/status, teams (list, find, get), usage (current, history), message search, statistics and threat summary, reported mail (list, get, item action preview), allow list, block list, VIPs, admins, verdict catalog, and a GET-only raw request restricted to documented endpoints.
- stdio and stateless Streamable HTTP transports (`/mcp`, `/health`), WYRE-compatible `X-Gateway-S2S` verification and `AUTH_MODE=gateway` with `X-Inky-Api-Key` / `X-Inky-Region` headers.
- EU/US region handling restricted to the documented INKY origins; bounded retries honouring `Retry-After`; response-size and output limits; no redirects; key redaction in logs and errors.
- Not published to any registry yet.
