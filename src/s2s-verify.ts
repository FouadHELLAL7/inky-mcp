/**
 * Verifies the gateway's service-to-service auth header, ported from the
 * WYRE-AI reference servers (huntress-mcp / itglue-mcp `s2s-verify.ts`,
 * gateway#377 parity) with the logic unchanged so inky-mcp drops into the
 * same gateway.
 *
 * Header: `X-Gateway-S2S: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "t=<t>")>`.
 * An empty secret always fails; the HTTP transport refuses to start without a
 * real secret unless MCP_ALLOW_INSECURE_DEV=1 (loopback only).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Request header carrying the S2S proof. Node lowercases incoming header names. */
export const S2S_HEADER = "x-gateway-s2s";

const HEADER_VALUE_RE = /^t=(\d{1,15}),v1=([0-9a-f]{64})$/;

export function verifyS2sHeader(headerValue: string | undefined, secret: string, maxSkewSeconds = 300): boolean {
  if (!secret || !headerValue) return false;
  const match = HEADER_VALUE_RE.exec(headerValue);
  if (!match) return false;
  const t = Number(match[1]);
  if (!Number.isSafeInteger(t)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > maxSkewSeconds) return false;
  const expected = createHmac("sha256", secret).update(`t=${t}`).digest();
  const provided = Buffer.from(match[2], "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Build a header value (used by tests and the smoke script to act as the gateway). */
export function signS2sHeader(secret: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", secret).update(`t=${nowSeconds}`).digest("hex");
  return `t=${nowSeconds},v1=${mac}`;
}
