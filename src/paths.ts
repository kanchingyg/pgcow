import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export function assertPathContained(target: string, root: string): string {
  const absRoot = resolve(root);
  const absTarget = resolve(absRoot, target);
  const rel = relative(absRoot, absTarget);
  if (rel.startsWith("..") || rel.includes(`${sep}..`)) {
    throw new Error(`Path outside sandbox root: ${target}`);
  }
  return absTarget;
}

export function branchStorageSlug(name: string): string {
  const slug = name
    .replace(/[/\\]/g, "--")
    .replace(/[:*?"<>|]/g, "_")
    .replace(/\s+/g, "-")
    .replace(/^\.+/, "")
    .trim();
  if (!slug) throw new Error(`Invalid branch name: ${name}`);
  return slug;
}

export function pgcowRoot(root: string): string {
  return join(root, ".pgcow");
}

export function branchWorkPath(root: string, branchName: string): string {
  const slug = branchStorageSlug(branchName);
  return assertPathContained(join("work", slug), pgcowRoot(root));
}

export function branchSnapshotPath(root: string, branchName: string): string {
  const slug = branchStorageSlug(branchName);
  return assertPathContained(join("snapshots", slug), pgcowRoot(root));
}

export function isReparsePoint(dataDir: string): boolean {
  if (!existsSync(dataDir)) return false;
  const st = lstatSync(dataDir);
  return st.isSymbolicLink();
}

export function sameResolvedPath(a: string, b: string): boolean {
  try {
    if (!existsSync(a) || !existsSync(b)) return false;
    return resolve(realpathSync(a)) === resolve(realpathSync(b));
  } catch {
    return false;
  }
}
