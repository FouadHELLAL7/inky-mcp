#!/usr/bin/env node
// Cross-platform "KEY=value ... -- command args": used by `npm run start:http`.
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 1) {
  console.error("usage: run-with-env.mjs KEY=value [...] -- command [args]");
  process.exit(2);
}
const env = { ...process.env };
for (const pair of argv.slice(0, sep)) {
  const i = pair.indexOf("=");
  env[pair.slice(0, i)] = pair.slice(i + 1);
}
const [command, ...rest] = argv.slice(sep + 1);
const child = spawn(command === "node" ? process.execPath : command, rest, { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
