#!/usr/bin/env node
// Build an MCP Bundle (.mcpb) for Claude Desktop: stage dist + production
// dependencies + manifest, then run the official `mcpb pack` CLI.
// Requires network access to fetch @anthropic-ai/mcpb via npx.
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const staging = join(root, ".mcpb-staging");
const run = (cmd, cwd = root) => {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd });
};

run("npm run build");
if (existsSync(staging)) rmSync(staging, { recursive: true });
mkdirSync(staging, { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
cpSync(join(root, "dist"), join(staging, "dist"), { recursive: true });
for (const file of ["package.json", "package-lock.json", "LICENSE", "README.md"]) cpSync(join(root, file), join(staging, file));

run("npm ci --omit=dev --ignore-scripts", staging);
run("npx -y @anthropic-ai/mcpb@2 validate manifest.json", staging);
run(`npx -y @anthropic-ai/mcpb@2 pack . ${join(root, `inky-mcp-${pkg.version}.mcpb`)}`, staging);
rmSync(staging, { recursive: true });
