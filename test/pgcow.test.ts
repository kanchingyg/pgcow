import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PKG_VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
).version as string;

import {
  ensureStore,
  createBranch,
  switchBranch,
  resetBranch,
  readMeta,
  assertEmbedDim,
} from "../src/branch-store.js";
import { cowCloneDir, hardlinkTree } from "../src/cow-engine.js";
import { branchStorageSlug, branchWorkPath } from "../src/paths.js";
import { syncDbBranchFromGit } from "../src/git-hook.js";
import {
  hijackStdoutForMcp,
  jsonRpcFrameLog,
  dispatchMcpMessage,
  setGuards,
  resetLoopBreaker,
  checkLoopBreaker,
  guardMutatingTool,
  windowsToWsl,
  wslToWindows,
  redactSecrets,
  headTailTruncate,
  parseDirtyToolCall,
  applyReasoningContentPolicy,
  createReasoningState,
  probeNCtx,
  normalizeEmbeddingsRequest,
  assertDimensionFingerprint,
  type McpToolDefinition,
} from "../src/bridge.js";
import { runCli } from "../src/cli.js";

function seedData(dir: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "data.txt"), content);
}

describe("branch isolation", () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pgcow-root-"));
    dataDir = join(root, "pgdata");
    seedData(dataDir, "main\n");
    ensureStore(root, dataDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("isolates branches and resets under 50ms", async () => {
    const t0 = performance.now();
    await createBranch(root, "feat-a", "main", { allowWrite: true });
    const branch = readMeta(root)!.branches["feat-a"];
    writeFileSync(join(branch.work, "data.txt"), "feat\n");
    switchBranch(root, "main");
    expect(readFileSync(join(dataDir, "data.txt"), "utf8")).toBe("main\n");
    switchBranch(root, "feat-a");
    expect(readFileSync(join(dataDir, "data.txt"), "utf8")).toBe("feat\n");
    const reset = resetBranch(root, "feat-a", { allowWrite: true });
    expect(reset.elapsedMs).toBeLessThan(50);
    expect(readFileSync(join(dataDir, "data.txt"), "utf8")).toBe("main\n");
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("cow clone is fast for small trees", async () => {
    const src = join(root, "tiny");
    const dest = join(root, "tiny-clone");
    seedData(src, "x\n");
    const res = await cowCloneDir(src, dest);
    expect(existsSync(join(dest, "data.txt"))).toBe(true);
    expect(res.elapsedMs).toBeLessThan(80);
  });
});

describe("MCP bridge", () => {
  let stderrChunks: string[];

  beforeEach(() => {
    stderrChunks = [];
    jsonRpcFrameLog.length = 0;
    resetLoopBreaker();
    setGuards({});
    const nativeStderr = process.stderr.write.bind(process.stderr);
    hijackStdoutForMcp();
    process.stderr.write = ((chunk: unknown, encoding?: BufferEncoding, cb?: (err?: Error | null) => void) => {
      stderrChunks.push(String(chunk));
      return nativeStderr(chunk as Buffer, encoding, cb);
    }) as typeof process.stderr.write;
  });

  const tools: McpToolDefinition[] = [
    {
      name: "switch_db_branch",
      description: "Switch active DB branch.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      handler: () => ({ dsn: "sqlite://work/main.db" }),
    },
    {
      name: "reset_db_branch",
      description: "Reset DB branch snapshot.",
      inputSchema: { type: "object", properties: {} },
      mutates: true,
      handler: () => ({ restored: true }),
    },
  ];

  it("handshake initialize and tools/list", () => {
    dispatchMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { name: "pgcow", version: PKG_VERSION },
      tools,
    );
    dispatchMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { name: "pgcow", version: PKG_VERSION },
      tools,
    );
    const init = JSON.parse(jsonRpcFrameLog[0]);
    expect(init.result.serverInfo.name).toBe("pgcow");
    const list = JSON.parse(jsonRpcFrameLog[1]);
    expect(list.result.tools).toHaveLength(2);
  });

  it("blindaje 4: paths and stdout hijack", async () => {
    expect(windowsToWsl("D:\\data\\pg")).toBe("/mnt/d/data/pg");
    expect(wslToWindows("/mnt/d/data/pg")).toBe("D:\\data\\pg");

    dispatchMcpMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "switch_db_branch", arguments: { name: "main" } },
      },
      { name: "pgcow", version: PKG_VERSION },
      tools,
      true,
    );
    await new Promise((r) => setTimeout(r, 20));
    const frame = JSON.parse(jsonRpcFrameLog.at(-1)!);
    expect(frame.result.content[0].text).toContain("sqlite");
    expect(jsonRpcFrameLog.every((l) => l.includes('"jsonrpc"'))).toBe(true);
  });

  it("blindaje 1: read-only and loop breaker", () => {
    const mutating = tools[1];
    expect(guardMutatingTool(mutating).blocked).toBe(true);
    setGuards({ allowWrite: true });
    expect(guardMutatingTool(mutating).blocked).toBe(false);
    expect(checkLoopBreaker("reset_db_branch", {})).toBeNull();
    expect(checkLoopBreaker("reset_db_branch", {})).toBeNull();
    expect(checkLoopBreaker("reset_db_branch", {})).toContain("LOOP_BREAKER");
  });

  it("blindaje 2: truncation and n_ctx probe", async () => {
    const long = "a".repeat(500);
    expect(headTailTruncate(long, 100).length).toBeLessThanOrEqual(100);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ max_model_len: 2048 }] }),
    }) as typeof fetch;
    const n = await probeNCtx("http://127.0.0.1:11434");
    expect(n).toBe(2048);
  });

  it("blindaje 3: embedding dimension lock", async () => {
    expect(() => assertDimensionFingerprint(1024, 768)).toThrow(/mismatch/);
    const res = await normalizeEmbeddingsRequest(
      { input: ["hi"], dimensions: 768, model: "nomic" },
      "ollama",
    );
    expect(res.data[0].embedding).toHaveLength(768);
  });

  it("blindaje 5: reasoning and dirty parser", () => {
    const state = createReasoningState();
    const out = applyReasoningContentPolicy(
      [
        { role: "assistant", reasoning_content: "think", tool_calls: [{}] },
        { role: "user" },
      ],
      state,
      true,
    );
    expect(out[0].reasoning_content).toBeUndefined();
    const thinking =
      "<" + "redacted_thinking" + ">x</" + "redacted_thinking" + ">";
    const parsed = parseDirtyToolCall(
      `${thinking}<tool_call>{"name":"switch_db_branch","arguments":{"name":"a"}}</tool_call>`,
      tools,
    );
    expect(parsed?.name).toBe("switch_db_branch");
  });

  it("redacts secrets in output", () => {
    expect(redactSecrets("token sk-abcdefghijklmnopqrstuvwxyz123456")).toContain("[REDACTED]");
  });
});

describe("paths and sync-git", () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pgcow-sync-"));
    dataDir = join(root, "pgdata");
    seedData(dataDir, "main\n");
    ensureStore(root, dataDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("slugifies git branch names for filesystem paths", () => {
    expect(branchStorageSlug("feat/x")).toBe("feat--x");
    expect(branchWorkPath(root, "feat/x")).toContain("feat--x");
  });

  it("sync-git creates branch from mocked git HEAD", async () => {
    const res = await syncDbBranchFromGit(root, { allowWrite: true, gitBranch: "feat/x" });
    expect(res.created).toBe(true);
    expect(res.branch).toBe("feat/x");
    expect(existsSync(join(root, ".pgcow", "work", "feat--x"))).toBe(true);
  });

  it("sync-git dry-run does not create work dirs", async () => {
    const res = await syncDbBranchFromGit(root, { dryRun: true, gitBranch: "new/branch" });
    expect(res.created).toBe(true);
    expect(existsSync(join(root, ".pgcow", "work", "new--branch"))).toBe(false);
  });
});

describe("cow hardlink fallback", () => {
  it("hardlinkTree clones small trees", async () => {
    const root = mkdtempSync(join(tmpdir(), "pgcow-hl-"));
    const src = join(root, "src");
    const dest = join(root, "dest");
    seedData(src, "hl\n");
    await hardlinkTree(src, dest);
    expect(readFileSync(join(dest, "data.txt"), "utf8")).toBe("hl\n");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("embed guard in store", () => {
  it("blocks dimension mismatch", () => {
    expect(() => assertEmbedDim({ dataDir: "x", active: "main", branches: {}, embedDim: 1024 }, 768)).toThrow();
  });
});

describe("cli", () => {
  let root: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    root = mkdtempSync(join(tmpdir(), "pgcow-cli-"));
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(root, { recursive: true, force: true });
  });

  it("init and branch flow", async () => {
    const code = await runCli(["init", "--data-dir", join(root, "pgdata"), "--allow-write"]);
    expect(code).toBe(0);
    const br = await runCli(["branch", "feat", "--allow-write", "--data-dir", join(root, "pgdata")]);
    expect(br).toBe(0);
    expect(existsSync(join(root, ".pgcow", "work", "feat"))).toBe(true);
  });
});
