---
name: pgcow
description: Instant local data-directory branches via OS copy-on-write, synced with git checkout (SQLite/local folders; not Postgres PGDATA).
---

# pgcow

Use when agents need isolated on-disk data state per git branch without full disk copies. Targets SQLite and other file-based data dirs  -  not a running PostgreSQL cluster.

## CLI

```bash
npx pgcow init --data-dir ./pgdata
npx pgcow branch feat-a --allow-write
npx pgcow checkout main
npx pgcow reset --allow-write
npx pgcow sync-git --allow-write
```

Git branch names with `/` are stored under `.pgcow/work/` using filesystem slugs (e.g. `feat/x` -> `feat--x`).

## MCP

```json
{
  "mcpServers": {
    "pgcow": {
      "command": "npx",
      "args": ["-y", "pgcow", "--mcp", "--allow-write"]
    }
  }
}
```

Tools: `create_db_branch`, `reset_db_branch`, `switch_db_branch`.

Destructive tools require `--allow-write`. Use `--dry-run` to probe CoW without writes.

## Local models

Point Ollama/LM Studio agents at the same repo; each agent can call `create_db_branch` for an isolated DSN while sharing CoW storage.
