# INKY External API notes

Verified facts about the INKY External API that `inky-mcp` is built on. Everything here comes from:

- The OpenAPI document **INKY External API 1.15.0** (OpenAPI 3.1.0), served by the portal at `https://docs.eu.inkyphishfence.com/api/1.15.0/inky-external-api.json` and by the API itself at `GET /v1/openapi.json` (no key needed). The EU and US API hosts both served 1.15.0 with the same 36 paths on 2026-11-13.
- The authenticated developer portal guides at `https://docs.eu.inkyphishfence.com` (`/overview.md`, `/api-keys.md`, `/errors.md`, `/pagination.md`, `/messages.md`, `/estate.md`; index at `/llms.txt`), read on 2026-11-13.
- The help-centre article *INKY API (beta)*: <https://help.inky.com/en/articles/5932023-inky-api-beta>.

The full vendor spec is **not** committed (it is INKY's document and is freely available from `/v1/openapi.json`). `npm run spec:fetch` downloads it to the git-ignored `openapi/` folder for local reference.

## 1. Hosts and regions

| Region | API base URL | Developer portal |
|---|---|---|
| EU | `https://api.eu.inkyphishfence.com` | `https://docs.eu.inkyphishfence.com` |
| US | `https://api.inkyphishfence.com` | `https://docs.inkyphishfence.com` |

- The portal hostname is **not** the API hostname. The EU portal documents the EU API host (spec `servers[0]`, "Production (EU)").
- "A key from one region doesn't work in the other" (help article). A key used against the wrong region answers `401 INVALID_API_KEY`.
- Paths are not prefixed by a base path: operations live at `/v1/...` and `/beta/...` directly on the host.
- `inky-mcp` accepts only these two origins (`INKY_REGION=eu|us`, or `INKY_API_BASE_URL` equal to one of them).

## 2. Authentication

- Every endpoint except `GET /v1/status` (and `/v1/openapi.json`) requires an API key in the **`X-API-Key`** request header (`securitySchemes.APIKeyHeader`).
- Keys are created in the INKY console under Settings / Admin Center → API Keys, by a **Super Admin** on the team or organization the key is for. There is no API to mint keys. The key is shown once.
- Key format: `inky_ext_` + 32 base62 characters + 6-character checksum. The first 16 characters are the **key prefix**, which is safe to log and is returned by `/v1/me` as `key_prefix`. The full key is never returned by any endpoint.
- **Scope**: fixed at creation. A team key reaches one team; an organization key (`$…` id) reaches every team beneath it. Out-of-scope resources answer `404`, not `403`.
- **Permissions** are per family/operation: API Access `read` (always on: `/v1/me`, teams, usage); Allow List `read/create/modify/delete/wildcard`; Block List `read/create/modify/delete`; VIP List and Admins `read/create/modify/delete`; Reported Mail `read/remediate`; Messages `read`; Statistics `read`. The **Default** key is read-only for teams and usage. Management families need an active Kaseya relationship for the account. A missing permission answers `403 FORBIDDEN`.
- **Expiry** is optional. Within 30 days of expiry responses carry `X-API-Key-Expires-Soon: true` and `X-API-Key-Expires-At`. An expired key answers `401 EXPIRED_API_KEY` (no grace).
- **Rotation**: the old key keeps working for 30 minutes; `/v1/me` then reports `status: "rotated"`, `rotated_at`, `grace_expires_at`. Revoked keys answer `401 INVALID_API_KEY`.
- No OAuth, bearer tokens or refresh flow exist.
- **Platform signature** (`X-Inky-Timestamp` + `X-Inky-Signature`, HMAC-SHA256 with a shared platform secret) is required only for partner keys whose role ends in `_integration`. Customer-issued keys do not sign; for them the check is a pass-through. The shared secret "is never exposed through the dashboard or customer-issued API keys". **`inky-mcp` does not implement signing** — an MSP's own console-issued key does not need it.

## 3. Tenancy model

- Every node is a **team** (`kind: "team"`, holds mailboxes) or an **organization node** (`kind: "org"`, groups other nodes; ids currently start with `$`, but `kind` is the contract). Each node has `parent_teamid`; the key's scope root has `parent_teamid: null`.
- `team_id` values are opaque; pass them back verbatim. `$` may be sent raw or as `%24`.
- Whether an organization node is accepted is per operation: allow/block lists and admins accept it (policy set there applies to every team beneath); messages search accepts it (searches every team beneath, refused with `422` above 1000 teams); statistics and VIP lists refuse it.
- `GET /v1/me` → `teamid` (scope root), `scope_type` (`org|team`), `permissions` map.

## 4. Implemented operations

All are `GET`. "Stable" = `/v1`, "Beta" = `/beta` ("may change shape or be removed without notice").

| Tool | Operation | Stability | Notes |
|---|---|---|---|
| `inky_status` | `GET /v1/status` (`getStatus`) | stable | unauthenticated, not rate limited |
| `inky_test_connection` | `GET /v1/me` (`getMe`) | stable | key prefix, scope, permissions, lifecycle |
| `inky_teams_list` | `GET /v1/teams` (`listTeams`) | stable | `cursor`, `limit` 1–999 (default 50) |
| `inky_teams_find` | `GET /v1/teams` (paged walk) | stable | client-side match on label / domain / id |
| `inky_teams_get` | `GET /v1/teams/{team_id}` (`getTeam`) | stable | `403 NO_SUBSCRIPTION` possible |
| `inky_usage_get` | `GET /v1/usage` (`getUsage`) | stable | `summary` is estate-wide on every page |
| `inky_usage_history` | `GET /v1/usage/history` (`getUsageHistory`) | stable | `days` 1–90 **or** `start_date`+`end_date` (≤365 d); `daily_totals` is whole on every page |
| `inky_messages_search` | `GET /beta/teams/{team_id}/messages` (`searchTeamMessages`) | beta | see §6 |
| `inky_statistics_get` | `GET /beta/teams/{team_id}/statistics[/reasons\|/result_categories]` | beta | team only; `since`/`until` dates |
| `inky_threat_summary` | statistics + statistics/reasons | beta | client-side totals and top reasons |
| `inky_reported_mail_list` | `GET /beta/reported_mail` (`listReportedMail`) or `GET /beta/teams/{team_id}/reported_mail` (`listTeamReportedMail`) | beta | `limit` 1–100 (default 25) |
| `inky_reported_mail_get` | `GET /beta/teams/{team_id}/reported_mail/{record_id}` (`getTeamReportedMail`) | beta | membership-independent |
| `inky_reported_mail_item_actions` | `GET /beta/teams/{team_id}/reported_mail/{record_id}/items/{item_id}/actions` (`listItemActions`) | beta | read, but needs `reported_mail.remediate` permission |
| `inky_allow_list_list` | `GET /beta/allow_list` (`listAllowList`) / `GET /beta/teams/{team_id}/allow_list` (`listTeamAllowList`) | beta | `inherited` only on per-team |
| `inky_allow_list_get` | `GET /beta/teams/{team_id}/allow_list/{entry_id}` (`getTeamAllowEntry`) | beta | |
| `inky_block_list_list` | `GET /beta/block_list` (`listBlockList`) / `GET /beta/teams/{team_id}/block_list` (`listTeamBlockList`) | beta | |
| `inky_block_list_get` | `GET /beta/teams/{team_id}/block_list/{entry_id}` (`getTeamBlockEntry`) | beta | |
| `inky_vips_list` | `GET /beta/vips` (`listVips`) / `GET /beta/teams/{team_id}/vips` (`listTeamVips`) | beta | never inherited; `inherited` is a 400 |
| `inky_vips_get` | `GET /beta/teams/{team_id}/vips/{entry_id}` (`getTeamVip`) | beta | |
| `inky_admins_list` | `GET /beta/admins` (`listAdmins`) / `GET /beta/teams/{team_id}/admins` (`listTeamAdmins`) | beta | estate list = direct grants only |
| `inky_admins_get` | `GET /beta/teams/{team_id}/admins/{email}` (`getTeamAdmin`) | beta | email path segment percent-encoded |
| `inky_result_types_list` | `GET /beta/result_types` (`listResultTypes`) | beta | takes no query parameters |
| `inky_raw_request` | any documented `GET` above | — | path allow-list derived from the spec |

### Parameters (verified)

- **Teams / usage**: `cursor`, `limit` (1–999, default 50; `/v1` clamps or substitutes silently, so `inky-mcp` validates the range itself).
- **Usage history**: `days` (1–90, default 30) mutually exclusive with `start_date` + `end_date` (`YYYY-MM-DD`, both required, ≤ 365 days); `cursor`, `limit`.
- **Allow list**: `sender`, `domain`, `result_type` (enum incl. `*`), `user_email`, `enabled`, plus `inherited` (per-team only, default `true`), `cursor`, `limit` (1–999, default 50).
- **Block list**: `from_email`, `from_domain`, `sender_ip`, `user_email`, `result_type` (`blocked_sender|spam_content|graymail|phishing_content|potential_sender_risk`), `enabled`, `inherited` (per-team), `cursor`, `limit`.
- **VIPs**: `email` (exact), `first_name`, `last_name` (case-insensitive prefix), `cursor`, `limit`.
- **Admins**: estate `email`, `cursor`, `limit`; per-team `inherited`, `cursor`, `limit`; single `inherited`.
- **Reported mail**: `search` (title substring), `created_since`, `created_until`, `updated_since` (ISO-8601 date-time), `rfc822_message_id`, `sender` (requires `rfc822_message_id`), `severity` (`informational|low|medium|high|critical`), `cursor`, `limit` (1–100, default 25). Any other filter (`status`, `priority`, …) is `400`.
- **Messages**: `since`, `until` (ISO-8601; default last 7 days; window ≤ 90 days), `recipient`, `sender`, `from_domain`, `rfc822_message_id`, `threat_level` (`danger|caution|neutral`), `reason` (repeatable), `delivery_target` (`inbox|junk|user_quarantine|admin_quarantine`), `result_category` (`neutral|caution-non-spam|caution-spam|caution-hi-spam|danger|danger-hi`), `reported` (bool), `detail` (bool), `cursor`, `limit` (1–100, default 25). `subject` and `q` are refused with `400`.
- **Statistics**: `since`, `until` (`YYYY-MM-DD`, inclusive, default last 30 closed UTC days ending yesterday; ≤ 90 days; `until` must be before today; not more than 179 days back). `reason` (repeatable) on `/reasons` only. No paging.
- Every `/beta` endpoint rejects undeclared query parameters with `400 VALIDATION_ERROR`; tools therefore send only declared parameters.

### Response shapes (abridged)

- Collections: `{ <collection>: [...], pagination: { next_cursor: string|null, limit } }`. Reported mail adds `poll_from`.
- `TeamDetail`: `team_id`, `kind`, `parent_teamid`, `team_label`, `disabled`, `created_at`, `domains[]` (`teamid` is a deprecated duplicate).
- `UsageResponse`: `data_as_of`, `is_trial`, `trial_end`, `summary.total_billable_mailboxes`, `teams[] {team_id, team_name, billable_mailbox_count, product_skus[]}`.
- `MessageRow`: `team_id`, `mailbox`, `rfc822_message_id`, `received_at`, `subject`, `sender {email, display_name, domain}`, `recipients[]`, `threat_level`, `reasons[] {code, label}`, `delivery_target`, `direction`, `has_attachments`, `link_count`, `reports {open, confirmed, rejected}`. `MessageDetail` adds `links[]`, `total_links`, `attachments[] {filename, content_type, size, sha256}`, `reply_to/to/cc/bcc[]`, `sender_ip`, `sender_country_code/name`, `helo`, `envelope_from`, `origin`, `known_external_sender`, `result_category`, `provider_signals`. **No message bodies** are exposed by the API. A record has no id; it is named by `team_id` + `mailbox` + `rfc822_message_id` + `received_at`.
- `ReportedMailRecord`: `id`, `team_id`, `title`, `record_type`, `status`, `resolution`, `priority`, `severity`, `assigned_to`, timestamps, `external_ticket`, `queue_route`, `item_count`, `items[] {id, rfc822_message_id, sender, status, reports[] {id, label, status, contact_email, comment, reported_at, …}}`.
- Allow-list entries are a union discriminated by `shape` (`sender`, `domain`, `domain_pair`, `sender_ip`, `display_name`, `url`, `address_pair`, `attachment`); all carry `id`, `team_id`, `result_type`, `result_type_label`, `enabled`, `inherited`, `user_email`, `updated_at`, `updated_by`.
- Statistics: `{team_id, since, until, days[] {date, neutral, caution, danger}}`; reasons `{…, reasons[] {date, reason, label, count}}`; result categories `{…, result_categories[] {date, result_category, count}}`.
- Error envelope: `{ "error": { "code": "...", "message": "...", "details"?: {...} } }`. Branch on `code`, never parse `message`.

### Dates

ISO-8601 UTC date-times for timestamps and windows (`since`/`until` on messages, `created_since` etc. on reported mail); `YYYY-MM-DD` for usage history and statistics. A naive date-time is read as UTC.

## 5. Pagination

Opaque cursor everywhere: pass `pagination.next_cursor` back as `cursor`; `null` means the end. Cursors belong to the endpoint and filter set that produced them (a misdirected cursor may be silently accepted), so tools return the cursor with the filters that produced it and never reuse one across tools. Only the named collection pages; summary fields (`summary`, `daily_totals`) are whole on every page. Statistics endpoints are not paged.

## 6. Errors, rate limits and retries

| Code | Status | `inky-mcp` behaviour |
|---|---|---|
| `MISSING_API_KEY`, `INVALID_API_KEY`, `EXPIRED_API_KEY`, `UNAUTHORIZED` | 401 | no retry; message hints at region mismatch / rotation |
| `PLATFORM_SIGNATURE_INVALID/REPLAYED` | 401/503 | no retry; explains signing is for `_integration` keys |
| `FORBIDDEN`, `NOT_ENTITLED`, `NO_SUBSCRIPTION`, `TEAM_SUSPENDED` | 403 | no retry; suggest checking `/v1/me` permissions |
| `NOT_FOUND` | 404 | no retry; "absent or outside the key's scope" |
| `VALIDATION_ERROR`, `INVALID_CURSOR`, `BAD_REQUEST`, … | 400/422 | no retry; upstream message returned |
| `RATE_LIMITED` | 429 | retry after `Retry-After` (bounded) |
| `POLLED_TOO_SOON` | 429 | **no retry**; advise `updated_since` = previous `poll_from` |
| `INTERNAL_ERROR` | 500 | retry with backoff (GET only) |
| `AUDIT_UNAVAILABLE` | 500 | never retried (write already committed) |
| `UPSTREAM_UNAVAILABLE` | 503 | retry, unless the message says the family is not available in this deployment |
| `SERVICE_OVERLOADED` | 503 | retry after `Retry-After` |

- Rate limits are per node (the node in the path, or the key's scope root for paths that name none) plus an organization-wide budget. No published numbers: read `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (Unix seconds). `Retry-After` on `429` is the time left in the window.
- Every response carries `X-Request-Id` (quote it to INKY support). `inky-mcp` includes it in error results.
- Only `429`, `500` and `503` are worth retrying (guide). `inky-mcp` retries GETs at most `INKY_MAX_RETRIES` (default 2) times and refuses to wait longer than `INKY_MAX_RETRY_WAIT_SECONDS` (default 30) for a single `Retry-After`.

## 7. Write operations (documented, not implemented)

Documented writes: allow/block list `POST`/`PATCH`/`DELETE` and `:batch`; VIP `POST`/`PATCH`/`DELETE`/`:batch`; admins `POST`/`PATCH`/`DELETE`; reported mail `:remediate`, `:dismiss`, `:review`, `actions:apply`, item `:remediate` (single and estate-wide bulk). `inky-mcp` 1.0 is **read-only**: these change mail-flow policy and console access across customer estates, all are `/beta`, and none were exercised against a live tenant. They are a candidate follow-up behind `INKY_ENABLE_WRITE_TOOLS=true` (see README). Notes for that work: writes are never signed; `AUDIT_UNAVAILABLE` means the write already committed; `TEAM_SUSPENDED` blocks writes only.

## 8. Not available in the API

| Category asked for | Status |
|---|---|
| Message bodies / raw MIME / attachment download | not exposed (metadata only) |
| Per-message id or per-message GET | none; search with `detail=true` |
| Free-text or subject search | refused by the API (`subject`, `q` → 400) |
| Outbound mail | never returned |
| Quarantine release / message deletion | no endpoint |
| Policies other than allow/block/VIP (e.g. banner settings) | no endpoint |
| Incidents / alerts as a separate entity | the closest equivalents are reported-mail records and `threat_level=danger` messages |
| Webhooks / push events | none ("the API only answers requests"); SIEM feed is a console feature |
| Reason-code catalog | none; learn codes from message rows (`reasons[].code`) |
| Estate-wide statistics | none; per team only |

## 9. Live checks still required

No INKY API key was available while building `inky-mcp`, so every tool was verified against mocked responses that follow the shapes above. Only the unauthenticated `GET /v1/status` was called live (EU and US both answered `{"status":"ok"}`). Remaining live checks are listed in the README.
