/**
 * inky_raw_request: GET-only escape hatch for documented INKY read endpoints
 * that no typed tool covers in exactly the needed shape.
 *
 * Safety model (stricter than autotask_raw_request in the reference servers):
 * - Only GET, and only paths matching a GET operation in INKY External API 1.15.0.
 * - Relative paths only; no scheme, host, query, fragment, backslash, "//",
 *   dot-segments, or encoded separators / double encoding.
 * - Dynamic segments are decoded once and re-encoded by the client, and the
 *   final URL is asserted to stay on the configured INKY origin.
 * - Query keys/values are bounded; credentials are always the caller's own.
 */

import { z } from "zod";
import { encodeSegment, type Query } from "../inky-client.js";
import { defineTool, reject } from "./common.js";

/** Every documented GET operation (INKY External API 1.15.0). Writes are not listed and cannot be reached. */
export const RAW_GET_TEMPLATES: readonly string[] = [
  "/v1/status",
  "/v1/me",
  "/v1/teams",
  "/v1/teams/{team_id}",
  "/v1/usage",
  "/v1/usage/history",
  "/beta/admins",
  "/beta/teams/{team_id}/admins",
  "/beta/teams/{team_id}/admins/{email}",
  "/beta/vips",
  "/beta/teams/{team_id}/vips",
  "/beta/teams/{team_id}/vips/{entry_id}",
  "/beta/block_list",
  "/beta/allow_list",
  "/beta/teams/{team_id}/block_list",
  "/beta/teams/{team_id}/allow_list",
  "/beta/teams/{team_id}/block_list/{entry_id}",
  "/beta/teams/{team_id}/allow_list/{entry_id}",
  "/beta/reported_mail",
  "/beta/teams/{team_id}/reported_mail",
  "/beta/teams/{team_id}/reported_mail/{record_id}",
  "/beta/teams/{team_id}/reported_mail/{record_id}/items/{item_id}/actions",
  "/beta/result_types",
  "/beta/teams/{team_id}/messages",
  "/beta/teams/{team_id}/statistics",
  "/beta/teams/{team_id}/statistics/reasons",
  "/beta/teams/{team_id}/statistics/result_categories",
];

// eslint-disable-next-line no-control-regex -- deliberately matching control characters to reject them
const FORBIDDEN_RAW = /[\s\u0000-\u001f\u007f?#\\]/;
const QUERY_KEY = /^[a-z][a-z0-9_]{0,63}$/;

export interface ValidatedRawPath {
  /** Path rebuilt from decoded segments with canonical encoding. */
  path: string;
  template: string;
}

/** Validate a caller-supplied path against the documented GET templates. Throws RequestRejectedError. */
export function validateRawPath(input: string): ValidatedRawPath {
  if (typeof input !== "string" || input.length === 0 || input.length > 1024) reject("path must be a non-empty string of at most 1024 characters.");
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) reject("path must be relative (no scheme or host).");
  if (!input.startsWith("/") || input.startsWith("//")) reject("path must start with a single '/', e.g. /v1/teams.");
  if (FORBIDDEN_RAW.test(input)) reject("path may not contain whitespace, control characters, '?', '#' or '\\'. Pass query parameters in 'query'.");
  if (input.includes("//")) reject("path may not contain empty segments ('//').");

  const rawSegments = input.replace(/\/+$/, "").split("/").slice(1);
  const decoded: string[] = [];
  for (const segment of rawSegments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      reject("path contains invalid percent-encoding.");
    }
    if (value === "." || value === ".." || segment === "." || segment === "..") reject("path may not contain '.' or '..' segments.");
    if (/[/\\]/.test(value)) reject("path segments may not contain encoded '/' or '\\'.");
    if (value.includes("%")) reject("path segments may not be double-encoded.");
    if (FORBIDDEN_RAW.test(value)) reject("path segments may not decode to control characters, whitespace, '?', '#' or '\\'.");
    decoded.push(value);
  }

  for (const template of RAW_GET_TEMPLATES) {
    const parts = template.split("/").slice(1);
    if (parts.length !== decoded.length) continue;
    const ok = parts.every((part, i) => (part.startsWith("{") ? decoded[i].length > 0 : part === decoded[i]));
    if (!ok) continue;
    const path = "/" + parts.map((part, i) => (part.startsWith("{") ? encodeSegment(decoded[i], part) : part)).join("/");
    return { path, template };
  }
  return reject(
    "path does not match a documented INKY GET endpoint. Allowed templates: " + RAW_GET_TEMPLATES.join(", "),
  );
}

const queryValue = z.union([
  z.string().max(1024),
  z.number(),
  z.boolean(),
  z.array(z.string().max(256)).max(20),
]);

export function validateRawQuery(query: Record<string, unknown> | undefined): Query | undefined {
  if (!query) return undefined;
  const keys = Object.keys(query);
  if (keys.length > 30) reject("query may contain at most 30 parameters.");
  for (const key of keys) {
    if (!QUERY_KEY.test(key)) reject(`query parameter name "${key.slice(0, 40)}" is not allowed (lowercase letters, digits, underscore).`);
  }
  return query as Query;
}

export const rawRequestTool = defineTool({
  name: "inky_raw_request",
  title: "INKY raw GET request",
  domain: "raw",
  description:
    "Escape hatch: send a GET to a documented INKY External API read endpoint and return the raw JSON. Prefer the typed tools. path is relative to the API origin and must match a documented GET template, e.g. /v1/teams, /beta/teams/{team_id}/messages, /beta/teams/{team_id}/statistics/reasons. Put query parameters in 'query' (arrays repeat the parameter). GET only; credentials, host and limits are fixed by the server. INKY rejects undeclared query parameters on /beta paths.",
  inputSchema: {
    path: z.string().min(1).max(1024).describe("Relative API path, e.g. /v1/teams or /beta/teams/$org1/allow_list."),
    query: z.record(z.string(), queryValue).optional().describe("Flat query parameters, e.g. {\"limit\": 10, \"reason\": [\"spam_content\"]}."),
  },
  handler: async (args, ctx) => {
    if (!ctx.config.rawRequestEnabled) reject("inky_raw_request is disabled on this server (INKY_ENABLE_RAW_REQUEST=false).");
    const { path, template } = validateRawPath(args.path);
    const query = validateRawQuery(args.query);
    const res = await ctx.client().get<unknown>(path, query, { authenticated: template !== "/v1/status" });
    return {
      request: { method: "GET", path, template },
      status: res.status,
      request_id: res.requestId ?? null,
      rate_limit: res.rateLimit ?? null,
      data: res.data,
    };
  },
});
