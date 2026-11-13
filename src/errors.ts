/**
 * Error types and the per-code guidance from INKY's "Errors and rate limits"
 * guide. Tools surface these as isError results; nothing here ever includes
 * the API key or request headers.
 */

import { maskInkyKey } from "./logger.js";

export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  reset?: number;
}

export class InkyApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  readonly details?: unknown;
  readonly rateLimit?: RateLimitInfo;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    requestId?: string;
    retryAfterSeconds?: number;
    details?: unknown;
    rateLimit?: RateLimitInfo;
  }) {
    super(maskInkyKey(init.message));
    this.name = "InkyApiError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.details = init.details;
    this.rateLimit = init.rateLimit;
  }
}

/** Raised when no usable credentials exist for this call. */
export class MissingCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCredentialsError";
  }
}

/** Raised before any request is sent (invalid path, bad arguments, …). */
export class RequestRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestRejectedError";
  }
}

const GUIDANCE: Record<string, string> = {
  MISSING_API_KEY: "No API key was sent. Configure INKY_API_KEY (stdio/env mode) or the X-Inky-Api-Key gateway header.",
  INVALID_API_KEY:
    "The API key is unknown or revoked. Check that the key belongs to this region (EU keys only work on api.eu.inkyphishfence.com, US keys on api.inkyphishfence.com) and has not been rotated or revoked. Do not retry.",
  EXPIRED_API_KEY: "The API key has expired. Rotate it in the INKY console (Settings → API Keys).",
  UNAUTHORIZED: "Authentication failed. Treat like an invalid key; do not retry.",
  PLATFORM_SIGNATURE_INVALID:
    "INKY expected an HMAC platform signature. Only partner keys whose role ends in _integration must sign; this server does not sign requests. Use a customer-issued console key.",
  PLATFORM_SIGNATURE_REPLAYED: "INKY rejected a replayed platform signature. This server does not sign requests.",
  FORBIDDEN:
    "The key lacks the permission this operation needs. Call inky_test_connection to see the key's permissions, then add the family (e.g. messages.read) to the key in the INKY console.",
  NOT_ENTITLED: "The organization is not entitled to this API surface (management families need an active Kaseya relationship). Contact INKY.",
  NO_SUBSCRIPTION: "The team has no active product subscription. Billing issue, not permissions.",
  TEAM_SUSPENDED: "The team is suspended. Configuration changes are withheld; reads keep working.",
  NOT_FOUND: "Not found, or outside the API key's scope (INKY deliberately does not distinguish the two). Check the id with inky_teams_list.",
  VALIDATION_ERROR: "INKY rejected a parameter. Fix the request; retrying will not help.",
  INVALID_CURSOR: "The pagination cursor is invalid, stale or from another endpoint. Restart paging without a cursor.",
  RATE_LIMITED: "INKY rate limit reached. Wait for the Retry-After interval and slow down; budgets are shared per node and per organization.",
  POLLED_TOO_SOON:
    "The same first page of reported mail was read less than 60 seconds ago. Instead of waiting, poll with updated_since set to the poll_from value of the previous read.",
  INTERNAL_ERROR: "INKY had an unexpected server error. Retry later.",
  UPSTREAM_UNAVAILABLE: "A service this INKY endpoint depends on is unavailable. Retry shortly.",
  SERVICE_OVERLOADED: "INKY is temporarily at capacity. Back off and retry after the Retry-After interval.",
  TIMEOUT: "The request to INKY timed out. Narrow the query (shorter window, smaller limit) or retry.",
  NETWORK_ERROR: "Could not reach the INKY API. Check network connectivity and the configured region.",
  RESPONSE_TOO_LARGE: "INKY's response exceeded the configured size limit (INKY_MAX_RESPONSE_BYTES). Use a smaller limit or narrower filters.",
  UNEXPECTED_REDIRECT: "INKY answered with a redirect. Redirects are never followed, so credentials cannot leak to another host.",
  INVALID_RESPONSE: "INKY returned a response that was not valid JSON.",
};

export function guidanceFor(code: string): string | undefined {
  return GUIDANCE[code];
}

/** Render any error as the text block a tool returns with isError: true. */
export function formatToolError(error: unknown): string {
  if (error instanceof InkyApiError) {
    const payload: Record<string, unknown> = {
      error: {
        source: "inky_api",
        http_status: error.status,
        code: error.code,
        message: error.message,
        guidance: guidanceFor(error.code),
        request_id: error.requestId,
        retry_after_seconds: error.retryAfterSeconds,
        details: error.details,
        rate_limit: error.rateLimit,
      },
    };
    return JSON.stringify(payload, null, 2);
  }
  if (error instanceof MissingCredentialsError) {
    return JSON.stringify({ error: { source: "configuration", code: "NO_CREDENTIALS", message: error.message } }, null, 2);
  }
  if (error instanceof RequestRejectedError) {
    return JSON.stringify({ error: { source: "inky_mcp", code: "REQUEST_REJECTED", message: error.message } }, null, 2);
  }
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify({ error: { source: "inky_mcp", code: "INTERNAL", message: maskInkyKey(message) } }, null, 2);
}
