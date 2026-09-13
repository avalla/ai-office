import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeCairnKeepMode =
  | "normal"
  | "extra-tools"
  | "wrong-server"
  | "stdout-noise"
  | "malformed-result"
  | "oversized"
  | "hang"
  | "hang-with-grandchild"
  | "hang-with-escaped-helper"
  | "exit-on-start"
  | "tool-error";

export interface FakeCairnKeepOptions {
  mode?: FakeCairnKeepMode;
  results?: readonly {
    key: string;
    value: string;
    score: number;
    scope?: string;
  }[];
}

export interface FakeCairnKeepLogEntry {
  kind: "start" | "request" | "grandchild";
  args?: string[];
  cwd?: string;
  environment?: Record<string, string>;
  method?: string;
  params?: unknown;
  pid?: number;
}

/**
 * A deterministic stand-in for `cairn memory-server`: a real executable that
 * speaks newline-delimited JSON-RPC over stdio. It never touches CairnKeep, a
 * provider, or the developer's memory stores. Every start and request is
 * appended to a log so tests can assert the exact protocol traffic.
 */
export function createFakeCairnKeep(options: FakeCairnKeepOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "ao-fake-cairn-"));
  const logPath = join(root, "log.jsonl");
  const command = join(root, "cairn");
  const configuration = JSON.stringify({
    mode: options.mode ?? "normal",
    results: options.results ?? [],
    logPath,
  });
  writeFileSync(
    command,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const config = ${configuration};
const log = (entry) => appendFileSync(config.logPath, JSON.stringify(entry) + "\\n");
log({ kind: "start", args: process.argv.slice(2), cwd: process.cwd(), environment: process.env });
if (config.mode === "exit-on-start") { process.stderr.write("fatal /secret/path\\n"); process.exit(3); }
if (config.mode === "hang-with-escaped-helper") {
  // A new session escapes the process group but inherits the stdio pipes.
  // perl (Linux and macOS) forks, calls setsid, and keeps the inherited pipes.
  const helper = spawn("perl", ["-e", "use POSIX; POSIX::setsid(); sleep 30"], { stdio: ["ignore", "inherit", "inherit"] });
  helper.unref();
  log({ kind: "grandchild", pid: helper.pid });
}
if (config.mode === "hang-with-grandchild") {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  log({ kind: "grandchild", pid: child.pid });
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  log({ kind: "request", method: message.method, params: message.params });
  if (message.id === undefined) return;
  if (config.mode === "hang" || config.mode.startsWith("hang-with-")) return;
  if (config.mode === "stdout-noise") { process.stdout.write("starting server...\\n"); return; }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: config.mode === "wrong-server" ? "other-memory" : "cairn-memory", version: "0.1.0" },
    }});
    return;
  }
  if (message.method === "tools/list") {
    const tools = [{ name: "memory_search", inputSchema: { type: "object" } }];
    if (config.mode === "extra-tools") tools.push({ name: "memory_write", inputSchema: { type: "object" } });
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
    return;
  }
  if (message.method === "tools/call") {
    if (config.mode === "tool-error") {
      send({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: "boom /secret/path" }] } });
      return;
    }
    if (config.mode === "oversized") {
      const value = "x".repeat(700 * 1024);
      const payload = { mode: "substring", count: 1, results: [{ scope: message.params.arguments.scope, key: "big", value, score: 1 }] };
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload } });
      return;
    }
    const scope = message.params.arguments.scope;
    const results = config.results.map((item) => ({ scope: item.scope ?? scope, key: item.key, value: item.value, score: item.score }));
    const payload = config.mode === "malformed-result"
      ? { mode: "substring", count: 1, results: [{ scope, key: 42, value: null }] }
      : { mode: "substring", count: results.length, results };
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload } });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
});
`,
  );
  chmodSync(command, 0o700);
  return {
    command,
    root,
    log(): FakeCairnKeepLogEntry[] {
      if (!existsSync(logPath)) return [];
      return readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as FakeCairnKeepLogEntry);
    },
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
