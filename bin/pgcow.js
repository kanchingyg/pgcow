#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

const candidates = [
  process.env.PGCOW_BIN,
  join(__dirname, "pgcow.exe"),
  join(__dirname, "pgcow"),
  join(__dirname, "..", "target", "release", "pgcow.exe"),
  join(__dirname, "..", "target", "release", "pgcow"),
  join(__dirname, "..", "target", "debug", "pgcow.exe"),
  join(__dirname, "..", "target", "debug", "pgcow"),
].filter(Boolean);

const native = candidates.find((p) => existsSync(p));
if (native) {
  const result = spawnSync(native, argv, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
  });
  const code = result.status ?? 1;
  if (!argv.includes("--mcp")) {
    process.exit(code);
  }
  process.exit(code);
}

const { runCli } = await import("../dist/cli.js");
const code = await runCli(argv);
if (!argv.includes("--mcp")) {
  process.exit(code);
}
