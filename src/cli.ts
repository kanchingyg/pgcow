#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createBranch,
  ensureStore,
  readMeta,
  resetBranch,
  switchBranch,
} from "./branch-store.js";
import { syncDbBranchFromGit } from "./git-hook.js";
import {
  setGuards,
  startMcpServer,
  type McpToolDefinition,
} from "./bridge.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version as string;

function parseFlags(argv: string[]): {
  flags: string[];
  rest: string[];
  dataDir?: string;
} {
  const flags: string[] = [];
  const rest: string[] = [];
  let dataDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir" && argv[i + 1]) {
      dataDir = argv[++i];
      continue;
    }
    if (a.startsWith("--")) flags.push(a);
    else rest.push(a);
  }
  return { flags, rest, dataDir };
}

function resolveDataDir(explicit?: string): string {
  return explicit ?? process.env.PGCOW_DATA_DIR ?? join(process.cwd(), "pgdata");
}

function buildMcpTools(root: string): McpToolDefinition[] {
  return [
    {
      name: "create_db_branch",
      description: "Clone data dir via CoW; returns DSN.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          from: { type: "string" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: { destructiveHint: false, readOnlyHint: false },
      mutates: true,
      handler: async (args, ctx) => {
        const name = String(args.name);
        const from = args.from ? String(args.from) : undefined;
        if (!readMeta(root)) ensureStore(root, resolveDataDir());
        return createBranch(root, name, from, {
          dryRun: ctx.dryRun,
          allowWrite: ctx.allowWrite,
        });
      },
    },
    {
      name: "reset_db_branch",
      description: "Restore branch snapshot instantly.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        additionalProperties: false,
      },
      annotations: { destructiveHint: true, readOnlyHint: false },
      mutates: true,
      handler: async (args, ctx) => {
        const name = args.name ? String(args.name) : undefined;
        return resetBranch(root, name, {
          dryRun: ctx.dryRun,
          allowWrite: ctx.allowWrite,
        });
      },
    },
    {
      name: "switch_db_branch",
      description: "Activate a DB branch and return DSN.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      mutates: false,
      handler: async (args) => {
        const name = String(args.name);
        return switchBranch(root, name);
      },
    },
  ];
}

export async function runCli(argv: string[]): Promise<number> {
  const { flags, rest, dataDir: flagDataDir } = parseFlags(argv);
  const root = process.cwd();
  const dataDir = resolveDataDir(flagDataDir);

  if (flags.includes("--dry-run")) setGuards({ dryRun: true });
  if (flags.includes("--allow-write")) setGuards({ allowWrite: true });

  if (flags.includes("--mcp")) {
    if (!readMeta(root)) ensureStore(root, dataDir);
    startMcpServer(
      { name: "pgcow", version: VERSION },
      buildMcpTools(root),
      { allowWrite: flags.includes("--allow-write") },
    );
    return 0;
  }

  const cmd = rest[0];
  if (!cmd) {
    process.stderr.write(
      "Usage: pgcow branch <name> | checkout <name> | reset | sync-git [--allow-write] [--dry-run] [--mcp]\n",
    );
    return 2;
  }

  try {
    if (cmd === "init") {
      mkdirSync(dataDir, { recursive: true });
      if (!existsSync(join(dataDir, "main.db"))) {
        writeFileSync(join(dataDir, "seed.txt"), "main\n");
      }
      ensureStore(root, dataDir);
      return 0;
    }

    if (!readMeta(root)) ensureStore(root, dataDir);

    if (cmd === "branch") {
      const name = rest[1];
      if (!name) return 2;
      const res = await createBranch(root, name, undefined, {
        allowWrite: flags.includes("--allow-write"),
        dryRun: flags.includes("--dry-run"),
      });
      process.stdout.write(`${res.dsn}\n`);
      return 0;
    }

    if (cmd === "checkout") {
      const name = rest[1];
      if (!name) return 2;
      const res = switchBranch(root, name);
      process.stdout.write(`${res.dsn}\n`);
      return 0;
    }

    if (cmd === "reset") {
      const res = resetBranch(root, rest[1], {
        allowWrite: flags.includes("--allow-write"),
        dryRun: flags.includes("--dry-run"),
      });
      process.stdout.write(`restored ${res.restored} in ${res.elapsedMs.toFixed(1)}ms\n`);
      return 0;
    }

    if (cmd === "sync-git") {
      const res = await syncDbBranchFromGit(root, {
        allowWrite: flags.includes("--allow-write"),
        dryRun: flags.includes("--dry-run"),
      });
      process.stdout.write(`${res.branch}${res.created ? " (created)" : ""}\n`);
      return 0;
    }

    process.stderr.write(`Unknown command: ${cmd}\n`);
    return 2;
  } catch (e) {
    process.stderr.write(String(e) + "\n");
    return 1;
  }
}

const isMain = process.argv[1]?.includes("cli");
if (isMain) {
  void runCli(process.argv.slice(2)).then((code) => {
    if (!process.argv.includes("--mcp")) process.exit(code);
  });
}
