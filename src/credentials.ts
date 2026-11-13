/**
 * Per-call credential resolution.
 *
 * - stdio, and HTTP with AUTH_MODE=env: INKY_API_KEY from the environment.
 * - HTTP with AUTH_MODE=gateway: X-Inky-Api-Key (+ optional X-Inky-Region)
 *   from each request. Gateway mode never falls back to the environment key.
 *
 * Every MCP server instance is built with its own resolver (one per HTTP
 * request in gateway mode), so a caller's credentials are captured in that
 * request's closure and can never be seen by another caller.
 */

import type { IncomingHttpHeaders } from "node:http";
import { INKY_REGIONS, parseRegion, type InkyRegion, type ServerConfig, ConfigError } from "./config.js";
import { MissingCredentialsError } from "./errors.js";

export interface InkyCredentials {
  /** INKY API key, sent as X-API-Key. Undefined only for unauthenticated calls such as /v1/status. */
  apiKey?: string;
  /** Validated origin of the INKY API for this caller. */
  baseUrl: string;
  region: InkyRegion | "test";
}

export type CredentialResolver = () => InkyCredentials;

export const GATEWAY_API_KEY_HEADER = "x-inky-api-key";
export const GATEWAY_REGION_HEADER = "x-inky-region";

const API_KEY_PATTERN = /^[\x21-\x7e]{8,512}$/;

/** Reject keys that could not be valid header values (whitespace, control characters, absurd length). */
export function normaliseApiKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === "") return undefined;
  if (!API_KEY_PATTERN.test(value)) {
    throw new MissingCredentialsError(
      "The INKY API key is malformed (expected 8-512 printable characters without spaces). Copy it again from the INKY console.",
    );
  }
  return value;
}

export function resolveBaseUrl(config: ServerConfig, requestedRegion?: InkyRegion): { baseUrl: string; region: InkyRegion | "test" } {
  if (config.testBaseUrl) return { baseUrl: config.testBaseUrl, region: "test" };
  if (config.pinnedBaseUrl) {
    if (requestedRegion && INKY_REGIONS[requestedRegion] !== config.pinnedBaseUrl) {
      throw new ConfigError(
        `This server is pinned to ${config.pinnedBaseUrl} (INKY_API_BASE_URL); region "${requestedRegion}" was requested.`,
      );
    }
    return { baseUrl: config.pinnedBaseUrl, region: requestedRegion ?? config.defaultRegion };
  }
  const region = requestedRegion ?? config.defaultRegion;
  return { baseUrl: INKY_REGIONS[region], region };
}

/** stdio / AUTH_MODE=env: read the key from the environment at call time. */
export function envCredentialResolver(config: ServerConfig, env: NodeJS.ProcessEnv = process.env): CredentialResolver {
  return () => {
    const { baseUrl, region } = resolveBaseUrl(config);
    return { apiKey: normaliseApiKey(env.INKY_API_KEY), baseUrl, region };
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export type GatewayCredentialResult =
  | { ok: true; credentials: InkyCredentials }
  | { ok: false; status: number; body: Record<string, unknown> };

/** Extract and validate gateway credentials from one HTTP request's headers. */
export function gatewayCredentialsFromHeaders(headers: IncomingHttpHeaders, config: ServerConfig): GatewayCredentialResult {
  let apiKey: string | undefined;
  try {
    apiKey = normaliseApiKey(headerValue(headers[GATEWAY_API_KEY_HEADER]));
  } catch (error) {
    return {
      ok: false,
      status: 401,
      body: { error: "Invalid credentials", message: (error as Error).message, required: ["X-Inky-Api-Key"] },
    };
  }
  if (!apiKey) {
    return {
      ok: false,
      status: 401,
      body: {
        error: "Missing credentials",
        message: "Gateway mode requires the X-Inky-Api-Key header on every request.",
        required: ["X-Inky-Api-Key"],
        optional: ["X-Inky-Region (eu | us)"],
      },
    };
  }
  try {
    const region = parseRegion(headerValue(headers[GATEWAY_REGION_HEADER]), "X-Inky-Region");
    const { baseUrl, region: resolvedRegion } = resolveBaseUrl(config, region);
    return { ok: true, credentials: { apiKey, baseUrl, region: resolvedRegion } };
  } catch (error) {
    return { ok: false, status: 400, body: { error: "Invalid region", message: (error as Error).message } };
  }
}

/** Resolver for a single gateway request: the credentials are fixed for this server instance. */
export function fixedCredentialResolver(credentials: InkyCredentials): CredentialResolver {
  const frozen = Object.freeze({ ...credentials });
  return () => frozen;
}
