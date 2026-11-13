/**
 * Levelled logger that writes every line to stderr, so the stdio transport's
 * JSON-RPC stream on stdout is never corrupted. Context objects pass through
 * redact() first: credential-looking keys are dropped and INKY API keys are
 * reduced to their public 16-character prefix.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
export type LogLevel = keyof typeof LEVELS;

const SENSITIVE_KEY = /(api[-_]?key|secret|authorization|cookie|token|password|signature|x-inky-api-key)/i;
const INKY_KEY_PATTERN = /inky_ext_[A-Za-z0-9]{8,}/g;

/** Mask an INKY key to its public prefix (the first 16 characters). */
export function maskInkyKey(value: string): string {
  return value.replace(INKY_KEY_PATTERN, (match) => `${match.slice(0, 16)}…[redacted]`);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (typeof value === "string") return maskInkyKey(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    if (value instanceof Error) return { name: value.name, message: maskInkyKey(value.message) };
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
}

function configuredLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL || "info").toLowerCase();
  return env in LEVELS ? (env as LogLevel) : "info";
}

function log(level: LogLevel, message: string, context?: unknown): void {
  if (LEVELS[level] < LEVELS[configuredLevel()]) return;
  const prefix = `${new Date().toISOString()} [${level.toUpperCase()}] ${maskInkyKey(message)}`;
  if (context === undefined) {
    console.error(prefix);
    return;
  }
  let contextStr: string;
  try {
    contextStr = JSON.stringify(redact(context));
  } catch {
    contextStr = "[unserializable]";
  }
  console.error(`${prefix} ${contextStr}`);
}

export const logger = {
  debug: (msg: string, ctx?: unknown) => log("debug", msg, ctx),
  info: (msg: string, ctx?: unknown) => log("info", msg, ctx),
  warn: (msg: string, ctx?: unknown) => log("warn", msg, ctx),
  error: (msg: string, ctx?: unknown) => log("error", msg, ctx),
};
