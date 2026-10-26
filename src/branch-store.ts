import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:os";

import { cowCloneDir, type CowMethod } from "./cow-engine.js";
import {
  branchSnapshotPath,
  branchStorageSlug,
  branchWorkPath,
  isReparsePoint,
  sameResolvedPath,
} from "./paths.js";

export type BranchMeta = {
  dataDir: string;
  active: string;
  branches: Record<string, { work: string; snapshot: string; slug: string }>;
  embedDir?: string;
  embedDim?: number;
};

const META = "meta.json";

export function metaPath(root: string): string {
  return join(root, ".pgcow", META);
}

export function readMeta(root: string): BranchMeta | null {
  const p = metaPath(root);
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, "utf8")) as BranchMeta;
  for (const [name, branch] of Object.entries(raw.branches)) {
    if (!branch.slug) {
      branch.slug = branchStorageSlug(name);
    }
  }
  return raw;
}

export function writeMeta(root: string, meta: BranchMeta): void {
  const dir = join(root, ".pgcow");
  mkdirSync(dir, { recursive: true });
  writeFileSync(metaPath(root), JSON.stringify(meta, null, 2));
}

function slugCollision(meta: BranchMeta, name: string): void {
  const slug = branchStorageSlug(name);
  for (const [existing, branch] of Object.entries(meta.branches)) {
    if (existing !== name && branch.slug === slug) {
      throw new Error(`Branch slug collision: '${name}' and '${existing}' both map to '${slug}'`);
    }
  }
}

function linkType(): "junction" | "dir" {
  return platform() === "win32" ? "junction" : "dir";
}

export function persistDataDirToBranch(meta: BranchMeta, branchName: string): void {
  const branch = meta.branches[branchName];
  if (!branch) return;
  const dataDir = resolve(meta.dataDir);
  const work = resolve(branch.work);
  if (!existsSync(dataDir) || isReparsePoint(dataDir)) return;
  if (sameResolvedPath(dataDir, work)) return;
  cpSync(dataDir, work, { recursive: true, force: true });
}

export function activateBranchDataDir(meta: BranchMeta): void {
  const branch = meta.branches[meta.active];
  if (!branch) throw new Error(`Unknown active branch: ${meta.active}`);

  const dataDir = resolve(meta.dataDir);
  const work = resolve(branch.work);

  if (existsSync(dataDir) && sameResolvedPath(dataDir, work)) return;

  if (existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true });
  }

  mkdirSync(dirname(dataDir), { recursive: true });
  symlinkSync(work, dataDir, linkType());
}

export function syncActiveDataDir(meta: BranchMeta): void {
  activateBranchDataDir(meta);
}

export function ensureStore(root: string, dataDir: string): BranchMeta {
  const existing = readMeta(root);
  if (existing) return existing;

  const workMain = branchWorkPath(root, "main");
  const snapMain = branchSnapshotPath(root, "main");
  mkdirSync(workMain, { recursive: true });

  if (existsSync(dataDir) && !isReparsePoint(dataDir)) {
    cpSync(dataDir, workMain, { recursive: true, force: true });
  }
  mkdirSync(snapMain, { recursive: true });
  cpSync(workMain, snapMain, { recursive: true, force: true });

  const meta: BranchMeta = {
    dataDir,
    active: "main",
    branches: {
      main: { work: workMain, snapshot: snapMain, slug: branchStorageSlug("main") },
    },
  };
  writeMeta(root, meta);
  syncActiveDataDir(meta);
  return meta;
}

export function dsnFor(dataDir: string): string {
  return `sqlite://${dataDir.replace(/\\/g, "/")}/main.db`;
}

export async function createBranch(
  root: string,
  name: string,
  from?: string,
  opts?: { dryRun?: boolean; allowWrite?: boolean },
): Promise<{ dsn: string; method?: CowMethod; elapsedMs?: number }> {
  if (!opts?.allowWrite && !opts?.dryRun) {
    throw new Error("Read-only: pass --allow-write to create branches.");
  }
  const meta = readMeta(root);
  if (!meta) throw new Error("Store not initialized");
  if (meta.branches[name]) throw new Error(`Branch exists: ${name}`);
  slugCollision(meta, name);

  const source = from ?? meta.active;
  const srcBranch = meta.branches[source];
  if (!srcBranch) throw new Error(`Source branch missing: ${source}`);

  const work = branchWorkPath(root, name);
  const snapshot = branchSnapshotPath(root, name);
  const slug = branchStorageSlug(name);

  if (opts?.dryRun) {
    const probe = await cowCloneDir(srcBranch.work, work, { dryRun: true });
    return { dsn: dsnFor(work), method: probe.method, elapsedMs: probe.elapsedMs };
  }

  const cloned = await cowCloneDir(srcBranch.work, work);
  mkdirSync(snapshot, { recursive: true });
  cpSync(work, snapshot, { recursive: true, force: true });

  meta.branches[name] = { work, snapshot, slug };
  writeMeta(root, meta);
  return { dsn: dsnFor(work), method: cloned.method, elapsedMs: cloned.elapsedMs };
}

export function switchBranch(
  root: string,
  name: string,
  opts?: { dryRun?: boolean },
): { dsn: string; link?: "junction" | "symlink" | "noop" } {
  const meta = readMeta(root);
  if (!meta) throw new Error("Store not initialized");
  if (!meta.branches[name]) throw new Error(`Branch missing: ${name}`);

  if (opts?.dryRun) {
    return { dsn: dsnFor(meta.dataDir), link: "noop" };
  }

  persistDataDirToBranch(meta, meta.active);
  meta.active = name;
  writeMeta(root, meta);
  syncActiveDataDir(meta);
  const link = platform() === "win32" ? "junction" : "symlink";
  return { dsn: dsnFor(meta.dataDir), link };
}

export function resetBranch(
  root: string,
  name?: string,
  opts?: { dryRun?: boolean; allowWrite?: boolean },
): { restored: string; elapsedMs: number } {
  if (!opts?.allowWrite && !opts?.dryRun) {
    throw new Error("Read-only: pass --allow-write to reset branches.");
  }
  const start = performance.now();
  const meta = readMeta(root);
  if (!meta) throw new Error("Store not initialized");
  const target = name ?? meta.active;
  const branch = meta.branches[target];
  if (!branch) throw new Error(`Branch missing: ${target}`);

  if (opts?.dryRun) {
    return { restored: branch.snapshot, elapsedMs: performance.now() - start };
  }

  const dataLinked = existsSync(meta.dataDir) && sameResolvedPath(meta.dataDir, branch.work);
  if (dataLinked && isReparsePoint(meta.dataDir)) {
    rmSync(meta.dataDir, { force: true });
  }

  rmSync(branch.work, { recursive: true, force: true });
  cpSync(branch.snapshot, branch.work, { recursive: true, force: true });
  if (meta.active === target) syncActiveDataDir(meta);
  return { restored: branch.work, elapsedMs: performance.now() - start };
}

export function assertEmbedDim(meta: BranchMeta, dim: number): void {
  if (meta.embedDim === undefined) return;
  if (meta.embedDim !== dim) {
    throw new Error(
      `Embedding dimension fingerprint mismatch: lock expects ${meta.embedDim}, got ${dim}`,
    );
  }
}

export function cloneEmbedIndex(
  root: string,
  fromBranch: string,
  toBranch: string,
  dim: number,
): void {
  const meta = readMeta(root);
  if (!meta?.embedDir) return;
  assertEmbedDim(meta, dim);
  const from = meta.branches[fromBranch]?.work;
  const to = meta.branches[toBranch]?.work;
  if (!from || !to) return;
  const src = join(from, meta.embedDir);
  const dest = join(to, meta.embedDir);
  if (!existsSync(src)) return;
  cpSync(src, dest, { recursive: true, force: true });
}
