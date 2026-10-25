import { createHash } from "node:crypto";

export const DEFAULT_N_CTX = 4096;
export const KNOWN_DIMENSIONS = [384, 768, 1024, 1536, 2560, 3072, 4096] as const;

export type McpToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type McpToolDefinition<TArgs = Record<string, unknown>, TResult = unknown> = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: McpToolAnnotations;
  mutates?: boolean;
  handler: (
    args: TArgs,
    ctx: { dryRun: boolean; allowWrite: boolean; nCtx: number },
  ) => Promise<TResult> | TResult;
};

let allowWrite = false;
let dryRun = false;
let nCtxBudget = DEFAULT_N_CTX;

export function setGuards(opts: {
  allowWrite?: boolean;
  dryRun?: boolean;
  nCtx?: number;
}): void {
  allowWrite = Boolean(opts.allowWrite);
  dryRun = Boolean(opts.dryRun);
  if (opts.nCtx && opts.nCtx > 0) nCtxBudget = opts.nCtx;
}

export function canonicalizeJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalizeJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`).join(",")}}`;
}

const loopState = { lastHash: "", repeatCount: 0 };

export function resetLoopBreaker(): void {
  loopState.lastHash = "";
  loopState.repeatCount = 0;
}

export function checkLoopBreaker(toolName: string, args: unknown): string | null {
  const h = createHash("sha256")
    .update(`${toolName}:${canonicalizeJson(args)}`)
    .digest("hex");
  if (h === loopState.lastHash) loopState.repeatCount++;
  else {
    loopState.lastHash = h;
    loopState.repeatCount = 1;
  }
  if (loopState.repeatCount >= 3) {
    return "LOOP_BREAKER: Identical tool call repeated 2 times consecutively. Stop calling tools and return your final synthesis.";
  }
  return null;
}

export function guardMutatingTool(tool: McpToolDefinition): { blocked: boolean; reason?: string } {
  if (!tool.mutates) return { blocked: false };
  if (dryRun) return { blocked: false };
  if (!allowWrite) {
    return {
      blocked: true,
      reason: "Read-only mode: pass --allow-write to enable mutating tools.",
    };
  }
  return { blocked: false };
}

const WIN_DRIVE_RE = /^([A-Za-z]):\\(.*)$/;
const WSL_RE = /^\/mnt\/([a-z])\/(.*)$/i;
const SECRET_RE =
  /(?:sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]+|api[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{8,})/gi;

export function windowsToWsl(p: string): string {
  const m = p.match(WIN_DRIVE_RE);
  if (!m) return p;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

export function wslToWindows(p: string): string {
  const m = p.match(WSL_RE);
  if (!m) return p;
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
}

export function normalizePathsDeep<T>(value: T, toWsl: boolean): T {
  if (typeof value === "string") {
    if (toWsl && WIN_DRIVE_RE.test(value)) return windowsToWsl(value) as T;
    if (!toWsl && WSL_RE.test(value)) return wslToWindows(value) as T;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => normalizePathsDeep(v, toWsl)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalizePathsDeep(v, toWsl);
    return out as T;
  }
  return value;
}

export function redactSecrets(text: string): string {
  return text.replace(SECRET_RE, "[REDACTED]");
}

export function headTailTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head - 24;
  return `${text.slice(0, head)}[...TRUNCATED...]${text.slice(-tail)}`;
}

export function toolOutputBudgetChars(nCtx: number, charsPerToken = 4): number {
  return Math.floor(nCtx * charsPerToken * 0.3);
}

export function truncateToolOutput(text: string, nCtx: number): string {
  return headTailTruncate(text, toolOutputBudgetChars(nCtx));
}

export function finalizeMcpToolText(
  text: string,
  opts?: { nCtx?: number; toWsl?: boolean },
): string {
  const nCtx = opts?.nCtx ?? DEFAULT_N_CTX;
  const toWsl = opts?.toWsl ?? false;
  return normalizePathsDeep(
    redactSecrets(truncateToolOutput(String(text), nCtx)),
    !toWsl,
  );
}

export function compactMcpPayload(obj: unknown, nCtx = DEFAULT_N_CTX): string {
  const raw = typeof obj === "string" ? obj : JSON.stringify(obj);
  return truncateToolOutput(redactSecrets(raw), nCtx);
}

export async function probeNCtx(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const base = baseUrl.replace(/\/$/, "");
  try {
    const props = await fetchImpl(`${base}/props`);
    if (props.ok) {
      const j = (await props.json()) as { n_ctx?: number };
      if (j.n_ctx && j.n_ctx > 0) return j.n_ctx;
    }
  } catch {
    /* continue */
  }
  try {
    const models = await fetchImpl(`${base}/v1/models`);
    if (models.ok) {
      const j = (await models.json()) as { data?: Array<{ max_model_len?: number }> };
      const n = j.data?.[0]?.max_model_len;
      if (n && n > 0) return n;
    }
  } catch {
    /* continue */
  }
  return DEFAULT_N_CTX;
}

export function buildRecencyAnchor(tools: McpToolDefinition[]): string {
  const lines = tools.map((t) => `- ${t.name}()`).join("\n");
  return `[TOOLS]\n${lines}\nCall: <tool_call>{"name":"...","arguments":{}}</tool_call>`;
}

export function stripRedactedThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/redacted_thinking>/gi, "");
}

function extractBalancedJson(text: string, start: number): string | null {
  const open = text.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

export function parseDirtyToolCall(
  rawOutput: string,
  tools: McpToolDefinition[],
): { name: string; arguments: Record<string, unknown> } | null {
  const cleaned = stripRedactedThinking(rawOutput);
  const inner = cleaned.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i)?.[1];
  const jsonStr =
    (inner ? extractBalancedJson(inner, 0) ?? inner.trim() : null) ??
    extractBalancedJson(cleaned, cleaned.search(/"name"/));
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr) as { name?: string; arguments?: Record<string, unknown> };
    const name = parsed.name ?? jsonStr.match(/"name"\s*:\s*"([^"]+)"/)?.[1];
    if (!name) return null;
    if (tools.length > 0 && !tools.some((t) => t.name === name)) return null;
    return { name, arguments: parsed.arguments ?? {} };
  } catch {
    const name = jsonStr.match(/"name"\s*:\s*"([^"]+)"/)?.[1];
    if (!name || (tools.length > 0 && !tools.some((t) => t.name === name))) return null;
    return { name, arguments: {} };
  }
}

export type ReasoningState = { inToolLoop: boolean };

export function createReasoningState(): ReasoningState {
  return { inToolLoop: false };
}

export function applyReasoningContentPolicy(
  messages: Array<{ role: string; reasoning_content?: string; tool_calls?: unknown[] }>,
  state: ReasoningState,
  newUserTurn: boolean,
): Array<{ role: string; reasoning_content?: string; tool_calls?: unknown[] }> {
  if (newUserTurn) state.inToolLoop = false;
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    if (newUserTurn && msg.reasoning_content) {
      const { reasoning_content: _, ...rest } = msg;
      return rest;
    }
    if (msg.tool_calls?.length) state.inToolLoop = true;
    return msg;
  });
}

let jsonRpcWrite: ((line: string) => void) | null = null;
let stdoutHijacked = false;

export const jsonRpcFrameLog: string[] = [];

export function hijackStdoutForMcp(): void {
  if (stdoutHijacked) return;
  stdoutHijacked = true;
  const native = process.stdout.write.bind(process.stdout);
  jsonRpcWrite = (line: string) => {
    native(line);
  };
  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    const str = typeof chunk === "string" ? chunk : Buffer.from(chunk as Buffer).toString();
    if (jsonRpcWrite && str.trim().startsWith("{") && str.includes('"jsonrpc"')) {
      return native(chunk as string, ...(args as []));
    }
    process.stderr.write(str);
    return true;
  }) as typeof process.stdout.write;
}

export function writeJsonRpcFrame(obj: object): void {
  const line = JSON.stringify(obj) + "\n";
  jsonRpcFrameLog.push(line);
  if (jsonRpcWrite) jsonRpcWrite(line);
  else process.stdout.write(line);
}

export function dispatchMcpMessage(
  msg: {
    jsonrpc?: string;
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
  },
  meta: { name: string; version: string },
  tools: McpToolDefinition[],
  pathToWsl = false,
): void {
  const { id, method, params } = msg;
  if (method === "initialize") {
    writeJsonRpcFrame({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: meta.name, version: meta.version },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    writeJsonRpcFrame({
      jsonrpc: "2.0",
      id,
      result: {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })),
      },
    });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name as string;
    const args = normalizePathsDeep(
      (params?.arguments as Record<string, unknown>) ?? {},
      pathToWsl,
    );
    const tool = tools.find((t) => t.name === name);
    const loopErr = checkLoopBreaker(name, args);
    if (loopErr) {
      writeJsonRpcFrame({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: loopErr }], isError: true },
      });
      return;
    }
    if (tool) {
      const guard = guardMutatingTool(tool);
      if (guard.blocked) {
        writeJsonRpcFrame({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: guard.reason ?? "blocked" }],
            isError: true,
          },
        });
        return;
      }
    }
    void (async () => {
      try {
        let result: unknown;
        if (tool) {
          result = await tool.handler(args, { dryRun, allowWrite, nCtx: nCtxBudget });
        } else {
          result = { ok: false, error: `Unknown tool: ${name}` };
        }
        const text =
          typeof result === "string" ? result : JSON.stringify(result, null, 2);
        writeJsonRpcFrame({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: finalizeMcpToolText(text, { nCtx: nCtxBudget, toWsl: pathToWsl }),
              },
            ],
          },
        });
      } catch (e) {
        writeJsonRpcFrame({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: finalizeMcpToolText(String(e), { nCtx: nCtxBudget, toWsl: pathToWsl }),
              },
            ],
            isError: true,
          },
        });
      }
    })();
    return;
  }

  if (id !== undefined) {
    writeJsonRpcFrame({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

export function startMcpServer(
  meta: { name: string; version: string },
  tools: McpToolDefinition[],
  options?: { allowWrite?: boolean; maxLoopRepeats?: number; pathToWsl?: boolean },
): void {
  hijackStdoutForMcp();
  if (options?.allowWrite) setGuards({ allowWrite: true });
  const toWsl = options?.pathToWsl ?? process.env.PGCOW_PATH_WSL === "1";

  const stdin = process.stdin;
  stdin.setEncoding("utf8");
  let buffer = "";
  stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as {
          jsonrpc?: string;
          id?: number | string;
          method?: string;
          params?: Record<string, unknown>;
        };
        dispatchMcpMessage(msg, meta, tools, toWsl);
      } catch {
        /* ignore */
      }
    }
  });
}

export function assertDimensionFingerprint(lockDim: number | undefined, dim: number): void {
  if (lockDim === undefined) return;
  if (lockDim !== dim) {
    throw new Error(`Dimension fingerprint mismatch: lock expects ${lockDim}, got ${dim}`);
  }
}

export async function normalizeEmbeddingsRequest(
  req: Record<string, unknown>,
  _provider: string,
): Promise<{ data: Array<{ embedding: number[]; index: number }>; model: string }> {
  const input = Array.isArray(req.input) ? req.input : req.input ? [req.input] : [];
  const dim = typeof req.dimensions === "number" ? req.dimensions : 768;
  assertDimensionFingerprint(
    typeof req.lockDimension === "number" ? req.lockDimension : undefined,
    dim,
  );
  const strings = input.map((x) => String(x));
  const data = strings.map((_, index) => ({
    index,
    embedding: new Array(dim).fill(0),
  }));
  return { data, model: String(req.model ?? "local") };
}
