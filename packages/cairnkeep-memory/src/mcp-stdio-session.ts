import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectMemoryError,
  type ProjectMemoryErrorCode,
} from "@ai-office/application/ports/project-memory-provider.port.ts";

/**
 * A short-lived, bounded MCP stdio client session.
 *
 * Only the JSON-RPC subset this adapter needs is implemented: newline-delimited
 * messages, client requests, and ignored server notifications. Everything a
 * server writes is untrusted: every stdout line must be one bounded JSON-RPC
 * object, stderr is drained and discarded, and every failure becomes a typed
 * {@link ProjectMemoryError} without provider text.
 */
export interface McpStdioSessionOptions {
  command: string;
  args: readonly string[];
  /** The complete child environment. Nothing is inherited implicitly. */
  environment: Readonly<Record<string, string>>;
  deadlineMs: number;
  maxMessageBytes: number;
  maxTotalBytes: number;
  signal?: AbortSignal;
}

const terminationGraceMs = 1_000;
const processGroupPollMs = 10;
const processGroupWaitMs = 2_000;
const maxStderrBytes = 64 * 1024;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: ProjectMemoryError) => void;
};

/** A function call so narrowing from an earlier check does not survive `await`. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class McpStdioSession {
  private child: ChildProcess | undefined;
  private directory: string | undefined;
  private failure: ProjectMemoryError | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private totalBytes = 0;
  private stderrBytes = 0;
  private initialized = false;
  private exited: Promise<void> = Promise.resolve();
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private readonly abort = () => this.fail("PROJECT_MEMORY_CANCELLED");

  private constructor(private readonly options: McpStdioSessionOptions) {}

  /** Starts the process in a private empty directory and its own process group. */
  static async start(
    options: McpStdioSessionOptions,
  ): Promise<McpStdioSession> {
    const session = new McpStdioSession(options);
    if (options.signal?.aborted === true)
      throw new ProjectMemoryError("PROJECT_MEMORY_CANCELLED");
    // A private cwd keeps repository-local provider configuration and
    // checkout-bound stores out of the invocation; nothing is read from it.
    session.directory = await mkdtemp(join(tmpdir(), "ai-office-memory-"));
    session.deadline = setTimeout(
      () => session.fail("PROJECT_MEMORY_TIMEOUT"),
      options.deadlineMs,
    );
    options.signal?.addEventListener("abort", session.abort, { once: true });
    // An abort delivered while the directory was being created has no listener.
    if (isAborted(options.signal)) session.abort();
    try {
      session.spawn();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  private spawn(): void {
    let child: ChildProcess;
    try {
      child = spawn(this.options.command, [...this.options.args], {
        cwd: this.directory!,
        env: { ...this.options.environment },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch {
      throw new ProjectMemoryError("PROJECT_MEMORY_UNAVAILABLE");
    }
    this.child = child;
    // Process exit, not stdio `close`: a helper that escaped the process group
    // can hold the pipes open indefinitely after the server itself is gone.
    this.exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    child.once("error", () => this.fail("PROJECT_MEMORY_UNAVAILABLE"));
    child.once("close", () =>
      this.fail(
        this.initialized
          ? "PROJECT_MEMORY_FAILED"
          : "PROJECT_MEMORY_UNAVAILABLE",
      ),
    );
    child.stdin?.on("error", () => this.fail("PROJECT_MEMORY_FAILED"));
    child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      // Diagnostic text may contain paths or secrets; it is counted, never kept.
      this.stderrBytes += chunk.byteLength;
      if (this.stderrBytes > maxStderrBytes)
        this.fail("PROJECT_MEMORY_RESPONSE_TOO_LARGE");
    });
  }

  private consume(chunk: Buffer): void {
    if (this.failure !== undefined) return;
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > this.options.maxTotalBytes) {
      this.fail("PROJECT_MEMORY_RESPONSE_TOO_LARGE");
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline = this.buffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.byteLength > this.options.maxMessageBytes) {
        this.fail("PROJECT_MEMORY_RESPONSE_TOO_LARGE");
        return;
      }
      this.handleLine(line.toString("utf8").replace(/\r$/u, ""));
      if (this.failure !== undefined) return;
      newline = this.buffer.indexOf(0x0a);
    }
    if (this.buffer.byteLength > this.options.maxMessageBytes)
      this.fail("PROJECT_MEMORY_RESPONSE_TOO_LARGE");
  }

  private handleLine(line: string): void {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Non-protocol stdout corrupts the stream; fail closed.
      this.fail("PROJECT_MEMORY_INVALID_RESPONSE");
      return;
    }
    const message = record(parsed);
    if (message === null || message.jsonrpc !== "2.0") {
      this.fail("PROJECT_MEMORY_INVALID_RESPONSE");
      return;
    }
    const hasId = Object.hasOwn(message, "id");
    if (typeof message.method === "string") {
      // A server request is refused; a notification is ignored.
      if (hasId)
        this.write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
      return;
    }
    if (typeof message.id !== "number") {
      this.fail("PROJECT_MEMORY_INVALID_RESPONSE");
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      this.fail("PROJECT_MEMORY_INVALID_RESPONSE");
      return;
    }
    this.pending.delete(message.id);
    if (Object.hasOwn(message, "error")) {
      pending.reject(new ProjectMemoryError("PROJECT_MEMORY_FAILED"));
      return;
    }
    if (!Object.hasOwn(message, "result")) {
      pending.reject(new ProjectMemoryError("PROJECT_MEMORY_INVALID_RESPONSE"));
      return;
    }
    pending.resolve(message.result);
  }

  private write(message: Readonly<Record<string, unknown>>): void {
    if (this.failure !== undefined) return;
    try {
      this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch {
      this.fail("PROJECT_MEMORY_FAILED");
    }
  }

  private fail(code: ProjectMemoryErrorCode): void {
    if (this.failure !== undefined) return;
    this.failure = new ProjectMemoryError(code);
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }

  request(
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  notify(method: string): void {
    this.write({ jsonrpc: "2.0", method });
  }

  /** Marks the protocol handshake complete; later exits are provider failures. */
  markInitialized(): void {
    this.initialized = true;
  }

  /**
   * Terminates the whole process group (the `cairn` launcher and its server
   * child), waits a bounded time for it to exit, and removes the private
   * directory. Every wait is bounded, so cleanup cannot hang a run even when a
   * descendant escaped the group (for example via `setsid`) and keeps the
   * pipes open; such an escaped process is outside the group this adapter owns.
   */
  async close(): Promise<void> {
    if (this.deadline !== undefined) clearTimeout(this.deadline);
    this.options.signal?.removeEventListener("abort", this.abort);
    this.fail("PROJECT_MEMORY_CANCELLED");
    const child = this.child;
    if (child !== undefined) {
      const pid = child.pid;
      const signalGroup = (signal: NodeJS.Signals) => {
        try {
          if (pid !== undefined) process.kill(-pid, signal);
        } catch {
          // Already gone.
        }
      };
      const within = (milliseconds: number) =>
        Promise.race([
          this.exited.then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), milliseconds),
          ),
        ]);
      child.stdin?.destroy();
      if (pid !== undefined && processGroupAlive(pid)) {
        signalGroup("SIGTERM");
        const exitedInTime = await within(terminationGraceMs);
        if (!exitedInTime || processGroupAlive(pid)) signalGroup("SIGKILL");
      }
      // Stop reading before any further wait; nothing more is consumed.
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (pid !== undefined) {
        await within(processGroupWaitMs);
        const waitUntil = Date.now() + processGroupWaitMs;
        while (processGroupAlive(pid) && Date.now() < waitUntil) {
          signalGroup("SIGKILL");
          await new Promise((resolve) =>
            setTimeout(resolve, processGroupPollMs),
          );
        }
      }
    }
    if (this.directory !== undefined)
      await rm(this.directory, { recursive: true, force: true });
  }
}
