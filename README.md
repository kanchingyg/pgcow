# pgcow

[![ci](https://github.com/kanchingyg/pgcow/actions/workflows/ci.yml/badge.svg)](https://github.com/kanchingyg/pgcow/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pgcow/latest?label=npm)](https://www.npmjs.com/package/pgcow)
[![JSR](https://jsr.io/badges/@kanchingyg/pgcow)](https://jsr.io/@kanchingyg/pgcow)
[![JSR Score](https://jsr.io/badges/@kanchingyg/pgcow/score)](https://jsr.io/@kanchingyg/pgcow/score)
[![Rust](https://img.shields.io/badge/engine-Rust_%2B_TypeScript-dea584)](https://github.com/kanchingyg/pgcow)
[![license](https://img.shields.io/github/license/kanchingyg/pgcow)](https://github.com/kanchingyg/pgcow/blob/HEAD/LICENSE)
[![npm](https://img.shields.io/npm/v/pgcow)](https://www.npmjs.com/package/pgcow)
[![JSR](https://jsr.io/badges/@kanchingyg/pgcow)](https://jsr.io/@kanchingyg/pgcow)
[![Rust](https://img.shields.io/badge/engine-Rust-dea584)](https://github.com/kanchingyg/pgcow)
[![license](https://img.shields.io/github/license/kanchingyg/pgcow)](https://github.com/kanchingyg/pgcow/blob/HEAD/LICENSE)

**One line:** `npx pgcow branch feat-a --allow-write` (or `bunx pgcow branch feat-a --allow-write`): instant local **data-directory branches** via OS copy-on-write, aligned with `git checkout`.

## What it is (and is not)

`pgcow` branches an on-disk **app data directory** (SQLite files, seeds, local vector indexes) under `.pgcow/work/`. It does **not** manage a live PostgreSQL `PGDATA` cluster (no `PG_VERSION` lifecycle, no running server handoff). Point `--data-dir` at whatever folder your tool reads; `pgcow` keeps per-git-branch copies cheap.

## Why

- **database-lab-engine (dblab):** ZFS/LVM thin clones on dedicated Linux hosts, not `npx` or `bunx` on a laptop.
- **Neon / Snaplet:** Cloud or slow dump workflows, not offline folders on disk.

**pgcow** clones trees with `clonefile` / reflink / hardlink fallbacks, then **junctions or symlinks** the active `--data-dir` to the selected branch work tree (no full-directory copy on checkout when linking works).

### Windows

Checkout uses **directory junctions** (`mklink /J` semantics via Node `symlink` type `junction`). Junctions require the work tree and `--data-dir` to live on the same volume; cross-volume paths fall back to copying on first `init` only.

## Install

[Bun](https://bun.sh) / [npm](https://www.npmjs.com/package/pgcow):

```bash
bunx pgcow init --data-dir ./pgdata
npx pgcow init --data-dir ./pgdata

# or install in your project / globally
bun add -d pgcow
npm i -D pgcow
```

[JSR](https://jsr.io/@kanchingyg/pgcow):

```bash
bunx jsr add @kanchingyg/pgcow
npx jsr add @kanchingyg/pgcow
```

[Cargo (Rust native binary)](https://github.com/kanchingyg/pgcow):

```bash
cargo install --git https://github.com/kanchingyg/pgcow
```

The core engine is **Rust** (`src/lib.rs`, `src/main.rs`, `src/mcp.rs`). TypeScript under `src/*.ts` is included for `npx` / `bunx` / JSR usage and MCP bridge helpers.

## Quick start

```bash
pgcow init --data-dir ./pgdata
pgcow branch feat-a --allow-write
pgcow checkout main
pgcow reset --allow-write
pgcow sync-git --allow-write   # maps git branch names; slashes become filesystem slugs
```

## MCP + local models

```bash
npx pgcow --mcp --allow-write
bunx pgcow --mcp --allow-write
```

Register in Cursor, Claude Code, or Ollama-driven agents so each session can `create_db_branch` without duplicating gigabytes on disk.

## Flags

| Flag | Purpose |
| --- | --- |
| `--allow-write` | Enable branch create/reset (default read-only) |
| `--dry-run` | Probe CoW / show restore plan |
| `--data-dir` | Active data directory (default `./pgdata`; not Postgres `PGDATA`) |
| `--mcp` | JSON-RPC MCP server on stdio |

## MCP Tools Reference

| Tool | Mutates | Description |
| --- | --- | --- |
| `create_db_branch` | `true` | Clone the active data directory into `.pgcow/work/<branch>` using OS copy-on-write (`clonefile`, `reflink`, or hardlink fallback; requires `--allow-write`). |
| `checkout_db_branch` | `true` | Point the active `--data-dir` symlink or Windows directory junction at the target branch worktree (requires `--allow-write`). |
| `list_db_branches` | `false` | List all local data branches and identify the currently linked branch. |
| `reset_db_branch` | `true` | Reset the active branch data directory back to its base snapshot (requires `--allow-write`). |

## Editor and Agent Integration

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "pgcow": {
      "command": "npx",
      "args": ["-y", "pgcow", "--mcp"]
    }
  }
}
```

### Claude Code CLI

```bash
claude mcp add pgcow -- npx -y pgcow --mcp
```

### Programmatic Usage (JSR / TypeScript)

```ts
import * as bridge from "jsr:@kanchingyg/pgcow/bridge";
```

## Runtime Safety and Guardrails

- **Stdio frame isolation**: When `--mcp` is active, `hijackStdoutForMcp()` redirects accidental `console.log` calls to `stderr` so JSON-RPC 2.0 frames on `stdout` never corrupt.
- **Read-only by default**: Mutating tools (`mutates: true`) are blocked in `--dry-run` mode and require explicit `--allow-write` authorization.
- **Loop breaker**: Repeated identical `(toolName, args)` invocations are hashed with SHA-256 and halted after 3 consecutive repeats to prevent runaway agent loops.
- **Context budget truncation**: Tool outputs are middle-truncated (`60%` head / `40%` tail) scaled to the probed local model `n_ctx` (Ollama `/api/show`, llama.cpp `/props`, vLLM `/v1/models`).
- **Secret redaction and path normalization**: AWS keys (`AKIA*`, `ASIA*`), bearer tokens, and `sk-*` keys are scrubbed before returning tool output, and Windows drive paths (`C:\...`) translate cleanly to `/mnt/c/...` when WSL mode is enabled.

## License

[MIT](./LICENSE)
