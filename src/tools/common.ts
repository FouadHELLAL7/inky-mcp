import { z, type ZodRawShape } from "zod";
import type { ServerConfig } from "../config.js";
import type { InkyClient } from "../inky-client.js";
import { RequestRejectedError } from "../errors.js";

export type Domain =
  | "account"
  | "teams"
  | "usage"
  | "messages"
  | "statistics"
  | "reported_mail"
  | "allow_block"
  | "vips"
  | "admins"
  | "reference"
  | "raw";

export interface ToolContext {
  /** Build a client for this call from the request-scoped credentials. */
  client(): InkyClient;
  config: ServerConfig;
}

export interface ToolDefinition<S extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  domain: Domain;
  inputSchema: S;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
}

/** Identity helper that keeps handler argument types tied to the schema. */
export function defineTool<S extends ZodRawShape>(tool: ToolDefinition<S>): ToolDefinition<S> {
  return tool;
}

// ---------------------------------------------------------------------------
// Shared input schemas
// ---------------------------------------------------------------------------

export const teamIdSchema = z
  .string()
  .min(1)
  .max(256)
  .describe("Team or organization node id exactly as returned by inky_teams_list (org node ids start with '$'). Opaque; pass verbatim.");

export const opaqueIdSchema = (what: string) =>
  z.string().min(1).max(256).describe(`${what}, exactly as returned by the API. Opaque; pass verbatim.`);

export const cursorSchema = z
  .string()
  .min(1)
  .max(4096)
  .optional()
  .describe("Opaque next_cursor from a previous call of THIS tool with the SAME filters. Omit for the first page.");

export const limitSchema = (max: number, def: number) =>
  z.number().int().min(1).max(max).optional().describe(`Page size, 1-${max} (default ${def}).`);

export const dateTimeSchema = (what: string) =>
  z
    .string()
    .max(64)
    .refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO-8601 date-time, e.g. 2026-11-01T00:00:00Z")
    .optional()
    .describe(`${what} (ISO-8601 date-time, UTC, e.g. 2026-11-01T00:00:00Z).`);

export const dateSchema = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .optional()
    .describe(`${what} (YYYY-MM-DD, UTC day).`);

export const emailSchema = (what: string) => z.string().min(3).max(320).optional().describe(what);

// ---------------------------------------------------------------------------
// Output shaping
// ---------------------------------------------------------------------------

/** Shorten long free text (subjects, comments, URLs) to keep results bounded. */
export function clip(value: unknown, max: number): unknown {
  if (typeof value !== "string" || value.length <= max) return value;
  return `${value.slice(0, max)}… [${value.length - max} more chars]`;
}

/** Drop null / undefined fields so rows stay compact. */
export function compact<T extends Record<string, unknown>>(row: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** Keep the first `max` items of an array and say how many were left out. */
export function capList<T>(items: readonly T[] | undefined | null, max: number): { items: T[]; omitted: number } {
  const list = items ?? [];
  return { items: list.slice(0, max), omitted: Math.max(0, list.length - max) };
}

export interface Pagination {
  next_cursor?: string | null;
  limit?: number;
}

export function pageInfo(pagination: Pagination | undefined, returned: number): Record<string, unknown> {
  const next = pagination?.next_cursor ?? null;
  return {
    returned,
    page_size: pagination?.limit,
    has_more: next !== null,
    next_cursor: next,
  };
}

export function reject(message: string): never {
  throw new RequestRejectedError(message);
}

/**
 * Serialise a tool result within the output budget. If it is too large, the
 * largest top-level array is shortened (never cut mid-JSON) and the result
 * says how many items were dropped and how to get them.
 */
export function fitToBudget(result: unknown, maxChars: number): string {
  let text = JSON.stringify(result, null, 2);
  if (text.length <= maxChars || !result || typeof result !== "object" || Array.isArray(result)) {
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… [output truncated at ${maxChars} characters]`;
  }
  const obj = { ...(result as Record<string, unknown>) };
  const arrayKeys = Object.keys(obj).filter((k) => Array.isArray(obj[k]));
  if (arrayKeys.length === 0) return `${text.slice(0, maxChars)}\n… [output truncated at ${maxChars} characters]`;
  const key = arrayKeys.reduce((a, b) => (JSON.stringify(obj[a]).length >= JSON.stringify(obj[b]).length ? a : b));
  const original = obj[key] as unknown[];
  let keep = original.length;
  while (keep > 0) {
    keep = Math.floor(keep * 0.75);
    obj[key] = original.slice(0, keep);
    obj.output_truncated = {
      field: key,
      shown: keep,
      omitted: original.length - keep,
      note: "Result shortened to fit the output budget (INKY_MAX_OUTPUT_CHARS). Use a smaller limit or narrower filters; for paged tools the omitted rows are NOT covered by next_cursor.",
    };
    text = JSON.stringify(obj, null, 2);
    if (text.length <= maxChars) return text;
  }
  return `${text.slice(0, maxChars)}\n… [output truncated at ${maxChars} characters]`;
}
