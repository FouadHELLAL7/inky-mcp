/**
 * Minimal, read-only HTTP client for the INKY External API.
 *
 * - Sends the key only as X-API-Key, only to the validated origin.
 * - GET only. Redirects are never followed (redirect: "manual").
 * - Per-request timeout, response-size cap, bounded retries for 429/500/503
 *   that honour Retry-After (POLLED_TOO_SOON and AUDIT_UNAVAILABLE are never retried).
 * - Never logs headers, keys or response bodies.
 */

import type { ServerConfig } from "./config.js";
import type { InkyCredentials } from "./credentials.js";
import { InkyApiError, MissingCredentialsError, RequestRejectedError, type RateLimitInfo } from "./errors.js";
import { logger } from "./logger.js";

export type QueryValue = string | number | boolean | readonly string[] | undefined | null;
export type Query = Record<string, QueryValue>;

export interface InkyResponse<T> {
  data: T;
  status: number;
  requestId?: string;
  rateLimit?: RateLimitInfo;
  keyExpiresSoon?: boolean;
  keyExpiresAt?: string;
}

export interface ClientDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const USER_AGENT = "inky-mcp/1.0.0";
// eslint-disable-next-line no-control-regex -- deliberately matching control characters to reject them
const SEGMENT_FORBIDDEN = /[\u0000-\u001f\u007f]/;

/**
 * Encode one dynamic path segment (team id, entry id, email, …).
 * encodeURIComponent turns "/", "?", "#" and "%" into escapes; "." and ".."
 * would still be dot-segments, so they are refused outright.
 */
export function encodeSegment(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new RequestRejectedError(`${name} must be a non-empty string.`);
  if (value.length > 512) throw new RequestRejectedError(`${name} is too long.`);
  if (SEGMENT_FORBIDDEN.test(value)) throw new RequestRejectedError(`${name} contains control characters.`);
  if (value === "." || value === "..") throw new RequestRejectedError(`${name} may not be "." or "..".`);
  return encodeURIComponent(value);
}

/** Build "/beta/teams/<enc>/messages" style paths from literal and dynamic parts. */
export function buildPath(literal: TemplateStringsArray, ...params: Array<[string, string]>): string {
  let out = literal[0];
  params.forEach(([name, value], i) => {
    out += encodeSegment(value, name) + literal[i + 1];
  });
  return out;
}

export function toSearchParams(query: Query | undefined): URLSearchParams {
  const params = new URLSearchParams();
  if (!query) return params;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  return params;
}

function parseIntHeader(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  return undefined;
}

function rateLimitFrom(headers: Headers): RateLimitInfo | undefined {
  const info: RateLimitInfo = {
    limit: parseIntHeader(headers.get("x-ratelimit-limit")),
    remaining: parseIntHeader(headers.get("x-ratelimit-remaining")),
    reset: parseIntHeader(headers.get("x-ratelimit-reset")),
  };
  return info.limit === undefined && info.remaining === undefined && info.reset === undefined ? undefined : info;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = parseIntHeader(response.headers.get("content-length"));
  if (declared !== undefined && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new InkyApiError({ status: response.status, code: "RESPONSE_TOO_LARGE", message: `Response of ${declared} bytes exceeds the ${maxBytes}-byte limit.` });
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new InkyApiError({ status: response.status, code: "RESPONSE_TOO_LARGE", message: `Response exceeds the ${maxBytes}-byte limit.` });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function fallbackCode(status: number): string {
  if (status === 400) return "VALIDATION_ERROR";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 405) return "METHOD_NOT_ALLOWED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 503) return "SERVICE_OVERLOADED";
  if (status >= 500) return "INTERNAL_ERROR";
  return `HTTP_${status}`;
}

function isRetryable(error: InkyApiError): boolean {
  if (error.status === 429) return error.code !== "POLLED_TOO_SOON";
  if (error.status === 500) return error.code !== "AUDIT_UNAVAILABLE";
  if (error.status === 502 || error.status === 504) return true;
  if (error.status === 503) {
    if (error.code === "PLATFORM_SIGNATURE_INVALID") return false;
    // "not available in this deployment" describes the environment, not the request.
    return !(error.code === "UPSTREAM_UNAVAILABLE" && /not available in this deployment/i.test(error.message));
  }
  return error.code === "NETWORK_ERROR";
}

export class InkyClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly credentials: InkyCredentials,
    private readonly config: ServerConfig,
    deps: ClientDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
  }

  get baseUrl(): string {
    return this.credentials.baseUrl;
  }

  get region(): string {
    return this.credentials.region;
  }

  /** Whether an API key is available for this call (the key itself is never exposed). */
  get hasApiKey(): boolean {
    return Boolean(this.credentials.apiKey);
  }

  /** Resolve a relative API path against the configured origin and refuse anything that escapes it. */
  resolveUrl(path: string, query?: Query): URL {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new RequestRejectedError("API paths must be relative and start with a single '/'.");
    }
    const url = new URL(path, this.credentials.baseUrl);
    if (url.origin !== new URL(this.credentials.baseUrl).origin) {
      throw new RequestRejectedError("Refusing to send a request outside the configured INKY API origin.");
    }
    url.search = toSearchParams(query).toString();
    return url;
  }

  async get<T>(path: string, query?: Query, options: { authenticated?: boolean } = {}): Promise<InkyResponse<T>> {
    const authenticated = options.authenticated ?? true;
    if (authenticated && !this.credentials.apiKey) {
      throw new MissingCredentialsError(
        "No INKY API key is configured. Set INKY_API_KEY (stdio / AUTH_MODE=env) or send X-Inky-Api-Key through the gateway.",
      );
    }
    const url = this.resolveUrl(path, query);

    let attempt = 0;
    for (;;) {
      try {
        return await this.once<T>(url, authenticated);
      } catch (error) {
        if (!(error instanceof InkyApiError) || !isRetryable(error) || attempt >= this.config.maxRetries) throw error;
        const waitSeconds = error.retryAfterSeconds;
        if (waitSeconds !== undefined && waitSeconds > this.config.maxRetryWaitSeconds) throw error;
        const backoffMs = waitSeconds !== undefined ? waitSeconds * 1000 : 500 * 2 ** attempt + Math.floor(Math.random() * 250);
        attempt += 1;
        logger.warn("Retrying INKY request", { path: url.pathname, status: error.status, code: error.code, attempt, waitMs: backoffMs });
        await this.sleep(backoffMs);
      }
    }
  }

  private async once<T>(url: URL, authenticated: boolean): Promise<InkyResponse<T>> {
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": USER_AGENT };
    if (authenticated && this.credentials.apiKey) headers["X-API-Key"] = this.credentials.apiKey;

    const started = this.now();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      const name = (error as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new InkyApiError({ status: 0, code: "TIMEOUT", message: `INKY did not answer within ${this.config.timeoutMs} ms.` });
      }
      throw new InkyApiError({ status: 0, code: "NETWORK_ERROR", message: `Could not reach ${url.origin}: ${(error as Error)?.message ?? "unknown error"}` });
    }

    const requestId = response.headers.get("x-request-id") ?? undefined;
    const rateLimit = rateLimitFrom(response.headers);
    logger.debug("INKY response", { path: url.pathname, status: response.status, ms: this.now() - started, requestId });

    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw new InkyApiError({ status: response.status, code: "UNEXPECTED_REDIRECT", message: "INKY answered with a redirect, which is not followed.", requestId });
    }

    const text = await readBodyCapped(response, this.config.maxResponseBytes);
    let body: unknown = undefined;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new InkyApiError({ status: response.status, code: "INVALID_RESPONSE", message: "INKY returned a non-JSON body.", requestId });
        }
      }
    }

    if (!response.ok) {
      const envelope = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined)?.error;
      const code = typeof envelope?.code === "string" ? envelope.code : fallbackCode(response.status);
      const message = typeof envelope?.message === "string" ? envelope.message : `INKY returned HTTP ${response.status}.`;
      throw new InkyApiError({
        status: response.status,
        code,
        message,
        requestId,
        retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after"), this.now()),
        details: envelope?.details,
        rateLimit,
      });
    }

    return {
      data: body as T,
      status: response.status,
      requestId,
      rateLimit,
      keyExpiresSoon: response.headers.get("x-api-key-expires-soon") === "true" ? true : undefined,
      keyExpiresAt: response.headers.get("x-api-key-expires-at") ?? undefined,
    };
  }
}
