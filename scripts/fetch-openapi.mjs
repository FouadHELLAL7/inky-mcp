#!/usr/bin/env node
// Download INKY's public OpenAPI document (GET /v1/openapi.json, no key needed)
// into the git-ignored openapi/ folder for local reference.
//   node scripts/fetch-openapi.mjs [eu|us]
import { mkdirSync, writeFileSync } from "node:fs";

const region = (process.argv[2] ?? process.env.INKY_REGION ?? "eu").toLowerCase();
const origins = { eu: "https://api.eu.inkyphishfence.com", us: "https://api.inkyphishfence.com" };
if (!origins[region]) {
  console.error("region must be eu or us");
  process.exit(2);
}
const res = await fetch(`${origins[region]}/v1/openapi.json`, { redirect: "error" });
if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  process.exit(1);
}
const spec = await res.json();
mkdirSync(new URL("../openapi/", import.meta.url), { recursive: true });
const file = new URL(`../openapi/inky-external-api-${spec.info?.version ?? "unknown"}-${region}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(spec, null, 2));
console.log(`Saved INKY External API ${spec.info?.version} (${Object.keys(spec.paths ?? {}).length} paths) to ${file.pathname}`);
