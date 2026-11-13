/**
 * Static configuration read from the process environment.
 *
 * Only non-secret settings live here. The INKY API key is resolved per
 * request by the credential resolver (see credentials.ts), never cached on a
 * module-level object.
 */

/** Documented INKY External API regions and their fixed origins. */
export const INKY_REGIONS = {
  eu: "https://api.eu.inkyphishfence.com",
  us: "https://api.inkyphishfence.com",
} as const;

export type InkyRegion = keyof typeof INKY_REGIONS;

export const DEFAULT_REGION: InkyRegion = "us";

export interface ServerConfig {
  /** Default region when neither INKY_API_BASE_URL nor a gateway region header says otherwise. */
  defaultRegion: InkyRegion;
  /** Origin pinned by INKY_API_BASE_URL (must be a documented INKY origin), if set. */
  pinnedBaseUrl?: string;
  /** Test-only loopback origin (INKY_TEST_BASE_URL). Never set in production. */
  testBaseUrl?: string;
  timeoutMs: number;
  maxRetries: number;
  maxRetryWaitSeconds: number;
  maxResponseBytes: number;
  maxOutputChars: number;
  rawRequestEnabled: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function isInkyRegion(value: string): value is InkyRegion {
  return Object.prototype.hasOwnProperty.call(INKY_REGIONS, value);
}

export function parseRegion(raw: string | undefined, source: string): InkyRegion | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "") return undefined;
  if (!isInkyRegion(value)) {
    throw new ConfigError(
      `${source} must be one of: ${Object.keys(INKY_REGIONS).join(", ")} (got "${raw.trim().slice(0, 20)}"). ` +
        "Use the region your INKY account lives in; a key from one region does not work in the other.",
    );
  }
  return value;
}

/** Normalise a configured base URL and require it to be a documented INKY origin. */
export function parsePinnedBaseUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError("INKY_API_BASE_URL is not a valid URL.");
  }
  const allowed = Object.values(INKY_REGIONS) as string[];
  const path = url.pathname.replace(/\/+$/, "");
  if (!allowed.includes(url.origin) || path !== "" || url.search || url.hash || url.username || url.password) {
    throw new ConfigError(
      `INKY_API_BASE_URL must be exactly one of ${allowed.join(" or ")} (no path, query or credentials).`,
    );
  }
  return url.origin;
}

/**
 * INKY_TEST_BASE_URL lets the mocked smoke tests point the server at a local
 * mock. It is accepted only for plain-http loopback origins, so it can never
 * redirect a real API key to a remote host.
 */
export function parseTestBaseUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError("INKY_TEST_BASE_URL is not a valid URL.");
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new ConfigError("INKY_TEST_BASE_URL is test-only and must be an http:// loopback origin.");
  }
  return url.origin;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new ConfigError(`${name} must be true or false.`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const pinnedBaseUrl = parsePinnedBaseUrl(env.INKY_API_BASE_URL);
  const region = parseRegion(env.INKY_REGION, "INKY_REGION");
  if (pinnedBaseUrl && region && INKY_REGIONS[region] !== pinnedBaseUrl) {
    throw new ConfigError("INKY_REGION and INKY_API_BASE_URL point at different INKY regions. Set only one.");
  }
  const regionFromBase = pinnedBaseUrl
    ? ((Object.keys(INKY_REGIONS) as InkyRegion[]).find((r) => INKY_REGIONS[r] === pinnedBaseUrl) ?? DEFAULT_REGION)
    : undefined;

  return {
    defaultRegion: region ?? regionFromBase ?? DEFAULT_REGION,
    pinnedBaseUrl,
    testBaseUrl: parseTestBaseUrl(env.INKY_TEST_BASE_URL),
    timeoutMs: intFromEnv(env, "INKY_TIMEOUT_MS", 30_000, 1_000, 120_000),
    maxRetries: intFromEnv(env, "INKY_MAX_RETRIES", 2, 0, 5),
    maxRetryWaitSeconds: intFromEnv(env, "INKY_MAX_RETRY_WAIT_SECONDS", 30, 0, 300),
    maxResponseBytes: intFromEnv(env, "INKY_MAX_RESPONSE_BYTES", 5 * 1024 * 1024, 64 * 1024, 50 * 1024 * 1024),
    maxOutputChars: intFromEnv(env, "INKY_MAX_OUTPUT_CHARS", 60_000, 5_000, 500_000),
    rawRequestEnabled: boolFromEnv(env, "INKY_ENABLE_RAW_REQUEST", true),
  };
}
