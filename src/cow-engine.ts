import { cp, mkdir, readdir, stat, link, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";

const execFileAsync = promisify(execFile);

export type CowMethod = "reflink" | "clonefile" | "hardlink" | "copy";

export type CowCloneResult = {
  method: CowMethod;
  elapsedMs: number;
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function hardlinkTree(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = join(src, ent.name);
    const d = join(dest, ent.name);
    if (ent.isDirectory()) {
      await hardlinkTree(s, d);
    } else if (ent.isFile()) {
      try {
        await link(s, d);
      } catch {
        await copyFile(s, d);
      }
    }
  }
}

async function tryReflinkCp(src: string, dest: string): Promise<boolean> {
  const plat = platform();
  try {
    if (plat === "darwin") {
      await execFileAsync("cp", ["-c", "-R", src, dest]);
      return true;
    }
    if (plat === "linux") {
      await execFileAsync("cp", ["--reflink=auto", "-R", src, dest]);
      return true;
    }
    if (plat === "win32") {
      await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        `Copy-Item -LiteralPath '${src.replace(/'/g, "''")}' -Destination '${dest.replace(/'/g, "''")}' -Recurse -Force`,
      ]);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export async function probeCowSupport(sampleDir: string): Promise<{
  supported: boolean;
  method: CowMethod;
}> {
  if (!(await pathExists(sampleDir))) {
    return { supported: false, method: "copy" };
  }
  const plat = platform();
  if (plat === "darwin") return { supported: true, method: "clonefile" };
  if (plat === "linux") return { supported: true, method: "reflink" };
  if (plat === "win32") return { supported: true, method: "copy" };
  return { supported: true, method: "hardlink" };
}

export async function cowCloneDir(
  src: string,
  dest: string,
  opts?: { dryRun?: boolean },
): Promise<CowCloneResult> {
  const start = performance.now();
  if (opts?.dryRun) {
    const probe = await probeCowSupport(src);
    return { method: probe.method, elapsedMs: performance.now() - start };
  }

  if (await pathExists(dest)) {
    throw new Error(`Destination already exists: ${dest}`);
  }

  if (platform() === "win32") {
    await cp(src, dest, { recursive: true, force: false });
    return { method: "copy", elapsedMs: performance.now() - start };
  }

  const reflink = await tryReflinkCp(src, dest);
  if (reflink) {
    return {
      method: platform() === "darwin" ? "clonefile" : "reflink",
      elapsedMs: performance.now() - start,
    };
  }

  try {
    await hardlinkTree(src, dest);
    return { method: "hardlink", elapsedMs: performance.now() - start };
  } catch {
    await cp(src, dest, { recursive: true, force: false });
    return { method: "copy", elapsedMs: performance.now() - start };
  }
}
