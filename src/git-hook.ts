import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createBranch, readMeta, switchBranch } from "./branch-store.js";

const execFileAsync = promisify(execFile);

export async function currentGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
    });
    const name = stdout.trim();
    if (!name || name === "HEAD") return null;
    return name;
  } catch {
    return null;
  }
}

export async function syncDbBranchFromGit(
  root: string,
  opts?: {
    allowWrite?: boolean;
    cwd?: string;
    dryRun?: boolean;
    gitBranch?: string;
  },
): Promise<{ branch: string; created: boolean }> {
  const cwd = opts?.cwd ?? root;
  const gitBranch = opts?.gitBranch ?? (await currentGitBranch(cwd));
  if (!gitBranch) throw new Error("Not a git repository or detached HEAD");

  const meta = readMeta(root);
  if (!meta) throw new Error("pgcow store not initialized");

  const exists = Boolean(meta.branches[gitBranch]);

  if (opts?.dryRun) {
    return { branch: gitBranch, created: !exists };
  }

  if (exists) {
    switchBranch(root, gitBranch);
    return { branch: gitBranch, created: false };
  }

  if (!opts?.allowWrite) {
    throw new Error(`No DB branch for git '${gitBranch}'. Use --allow-write to create.`);
  }

  await createBranch(root, gitBranch, meta.active, { allowWrite: true });
  switchBranch(root, gitBranch);
  return { branch: gitBranch, created: true };
}
