import { createHash } from "node:crypto";
import { productVersion } from "@ai-office/command-support/version.ts";
import {
  ProjectMemoryError,
  projectMemoryErrorMessage,
  projectMemoryLimits,
  type ProjectMemoryHit,
  type ProjectMemoryProvider,
  type ProjectMemoryProviderDiagnostic,
  type ProjectMemoryQuery,
  type ProjectMemorySearch,
} from "@ai-office/application/ports/project-memory-provider.port.ts";
import { McpStdioSession } from "./mcp-stdio-session.ts";

/**
 * CairnKeep adapter: one bounded `cairn memory-server` stdio session per
 * retrieval, restricted server-side to the single read-only tool it needs.
 *
 * Contract used (CairnKeep 2.17.x, documented MCP tool surface):
 * - `initialize` must report `serverInfo.name === "cairn-memory"` and tools;
 * - `CAIRN_MCP_TOOL_PROFILE=custom` + `CAIRN_MCP_ALLOWED_TOOLS=memory_search`
 *   must leave exactly `memory_search` registered, otherwise the server is
 *   treated as incompatible and nothing is called;
 * - `memory_search {scope, query, top_k}` with the named scope equal to the
 *   derived project memory identity, returning `{count, results:[{scope, key,
 *   value, score}]}` as structured content or JSON text.
 *
 * The named scope, not CairnKeep's cwd-bound `project` scope, carries project
 * identity: over stdio `project` resolves to `<cwd>/.agentfs/project.db`, which
 * would bind memory to one checkout.
 */
export const cairnKeepProviderId = "cairnkeep";
export const cairnKeepServerName = "cairn-memory";
export const cairnKeepSearchTool = "memory_search";
const protocolVersion = "2025-06-18";
const maxProviderResults = 50;
const maxConcurrentSessions = 2;

/** Every variable the child receives. Provider and model secrets are excluded. */
const inheritedEnvironment = [
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "CAIRN_AGENTFS_BASE_DIR",
] as const;

/**
 * Function words plus generic task verbs. Task titles are usually imperative
 * ("Document the deploy flow"); the verb says what to do, the remaining words
 * name what memory is about.
 */
const substringStopWords = new Set([
  "about",
  "after",
  "and",
  "before",
  "for",
  "from",
  "into",
  "that",
  "the",
  "then",
  "this",
  "use",
  "when",
  "with",
  "without",
  "add",
  "adds",
  "allow",
  "analyse",
  "analyze",
  "build",
  "change",
  "check",
  "clean",
  "cleanup",
  "create",
  "delete",
  "design",
  "disable",
  "document",
  "enable",
  "ensure",
  "explain",
  "fix",
  "handle",
  "implement",
  "improve",
  "introduce",
  "investigate",
  "make",
  "migrate",
  "move",
  "prevent",
  "refactor",
  "remove",
  "rename",
  "review",
  "support",
  "test",
  "tests",
  "tune",
  "update",
  "upgrade",
  "validate",
  "write",
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalid(): ProjectMemoryError {
  return new ProjectMemoryError("PROJECT_MEMORY_INVALID_RESPONSE");
}

/**
 * CairnKeep's default (non-embedding) search matches the entire query as one
 * case-insensitive substring. A task title therefore almost never matches, so
 * the adapter sends its single most distinctive term: the longest word of at
 * least three code points that is neither a function word nor a generic task
 * verb, earliest on ties. Without such a word the bounded query is sent
 * unchanged. Still exactly one search; recall is deliberately modest.
 */
export function cairnKeepSearchTerm(query: string): string {
  let best = "";
  for (const match of query
    .toLocaleLowerCase()
    .matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)) {
    const term = match[0];
    const length = [...term].length;
    if (length < 3 || substringStopWords.has(term)) continue;
    if (length > [...best].length) best = term;
  }
  return best === "" ? query : best;
}

export function cairnKeepChildEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const name of inheritedEnvironment) {
    const value = environment[name];
    if (value !== undefined) child[name] = value;
  }
  // Enforced by the server: tools outside the profile are never registered.
  child.CAIRN_MCP_TOOL_PROFILE = "custom";
  child.CAIRN_MCP_ALLOWED_TOOLS = cairnKeepSearchTool;
  return child;
}

interface SearchPayloadResult {
  scope: string;
  key: string;
  value: string;
  score: number;
}

/** Validates one `memory_search` tool result. Anything unexpected fails closed. */
export function parseCairnKeepSearchResult(
  result: unknown,
  scope: string,
): SearchPayloadResult[] {
  const envelope = record(result);
  if (envelope === null) throw invalid();
  if (envelope.isError === true)
    throw new ProjectMemoryError("PROJECT_MEMORY_FAILED");
  let payload = record(envelope.structuredContent);
  if (payload === null) {
    const content = envelope.content;
    const first = Array.isArray(content) ? record(content[0]) : null;
    if (first?.type !== "text" || typeof first.text !== "string")
      throw invalid();
    try {
      payload = record(JSON.parse(first.text));
    } catch {
      throw invalid();
    }
    if (payload === null) throw invalid();
  }
  const results = payload.results;
  if (
    !Array.isArray(results) ||
    results.length > maxProviderResults ||
    payload.count !== results.length
  )
    throw invalid();
  return results.map((item) => {
    const value = record(item);
    if (
      value === null ||
      value.scope !== scope ||
      typeof value.key !== "string" ||
      value.key.length === 0 ||
      value.key.length > projectMemoryLimits.referenceCharacters ||
      /\p{Cc}/u.test(value.key) ||
      typeof value.value !== "string" ||
      typeof value.score !== "number" ||
      !Number.isFinite(value.score)
    )
      throw invalid();
    return {
      scope: value.scope,
      key: value.key,
      value: value.value,
      score: value.score,
    };
  });
}

/**
 * Deterministic normalization: score descending, then key by code unit, then
 * the first `limit` results. Excerpts are capped at the per-result limit; the
 * content digest is AI Office's SHA-256 of the complete remembered value, so
 * provenance identifies the exact record version without storing it.
 * Control and format characters other than tab and newline become spaces.
 */
export function normalizeCairnKeepResults(
  results: readonly SearchPayloadResult[],
  limit: number,
): ProjectMemoryHit[] {
  return [...results]
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
    )
    .slice(0, limit)
    .map((result) => {
      const excerptLimit = projectMemoryLimits.excerptCharacters;
      // Control and format characters (other than tab and newline) are
      // replaced before injection: they carry no memory meaning, expand under
      // JSON escaping, and can disguise text. The digest covers the original.
      const codePoints = [
        ...result.value.replace(/[^\P{Cc}\t\n]|\p{Cf}/gu, " "),
      ];
      const truncated = codePoints.length > excerptLimit;
      return {
        referenceId: result.key,
        contentDigest: `sha256:${createHash("sha256").update(result.value, "utf8").digest("hex")}`,
        scope: result.scope,
        title: null,
        excerpt: codePoints.slice(0, excerptLimit).join(""),
        truncated,
      };
    });
}

function parseInitialize(result: unknown): string {
  const value = record(result);
  const serverInfo = record(value?.serverInfo);
  const capabilities = record(value?.capabilities);
  if (
    value === null ||
    typeof value.protocolVersion !== "string" ||
    serverInfo?.name !== cairnKeepServerName ||
    typeof serverInfo.version !== "string" ||
    !/^[0-9A-Za-z.+-]{1,64}$/u.test(serverInfo.version) ||
    record(capabilities?.tools) === null
  )
    throw new ProjectMemoryError("PROJECT_MEMORY_INCOMPATIBLE");
  return serverInfo.version;
}

function assertReadOnlyToolSurface(result: unknown): void {
  const value = record(result);
  const tools = value?.tools;
  if (!Array.isArray(tools)) throw invalid();
  const names = tools.map((tool) => record(tool)?.name);
  // Exactly one tool: an annotation is not an authorization boundary, so a
  // server that exposes anything else did not honor the profile.
  if (names.length !== 1 || names[0] !== cairnKeepSearchTool)
    throw new ProjectMemoryError("PROJECT_MEMORY_INCOMPATIBLE");
}

class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly capacity: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (this.active >= this.capacity)
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const index = this.waiting.indexOf(ready);
          if (index !== -1) this.waiting.splice(index, 1);
          reject(new ProjectMemoryError("PROJECT_MEMORY_TIMEOUT"));
        };
        const ready = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        this.waiting.push(ready);
      });
    else this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next === undefined) this.active -= 1;
      else next();
    };
  }
}

export interface CairnKeepMemoryProviderOptions {
  command: string;
  timeoutMs: number;
  environment: Readonly<Record<string, string | undefined>>;
}

export class CairnKeepMemoryProvider implements ProjectMemoryProvider {
  readonly id = cairnKeepProviderId;
  private readonly sessions = new Semaphore(maxConcurrentSessions);

  constructor(private readonly options: CairnKeepMemoryProviderOptions) {}

  describe(): ProjectMemoryProviderDiagnostic {
    return {
      provider: this.id,
      state: "configured",
      version: null,
      code: null,
      message:
        "CairnKeep project memory is configured; availability is checked only by an explicit probe or a run.",
    };
  }

  async probe(signal?: AbortSignal): Promise<ProjectMemoryProviderDiagnostic> {
    try {
      const version = await this.withSession(signal, async (session) => {
        const version = await this.handshake(session);
        return version;
      });
      return {
        provider: this.id,
        state: "available",
        version,
        code: null,
        message:
          "CairnKeep answered with exactly the read-only memory_search tool.",
      };
    } catch (error) {
      const code =
        error instanceof ProjectMemoryError
          ? error.code
          : "PROJECT_MEMORY_FAILED";
      return {
        provider: this.id,
        state: "unavailable",
        version: null,
        code,
        message: projectMemoryErrorMessage(code),
      };
    }
  }

  async search(query: ProjectMemoryQuery): Promise<ProjectMemorySearch> {
    const limit = Math.min(
      Math.max(Math.trunc(query.limit), 1),
      projectMemoryLimits.maxResults,
    );
    const scope = query.identity.memoryProjectId;
    return this.withSession(query.signal, async (session) => {
      const version = await this.handshake(session);
      const result = await session.request("tools/call", {
        name: cairnKeepSearchTool,
        arguments: {
          scope,
          query: cairnKeepSearchTerm(query.text),
          top_k: limit,
        },
      });
      return {
        provider: { id: this.id, version },
        hits: normalizeCairnKeepResults(
          parseCairnKeepSearchResult(result, scope),
          limit,
        ),
      };
    });
  }

  private async handshake(session: McpStdioSession): Promise<string> {
    const version = parseInitialize(
      await session.request("initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "ai-office", version: productVersion },
      }),
    );
    session.markInitialized();
    session.notify("notifications/initialized");
    assertReadOnlyToolSurface(await session.request("tools/list", {}));
    return version;
  }

  private async withSession<T>(
    signal: AbortSignal | undefined,
    work: (session: McpStdioSession) => Promise<T>,
  ): Promise<T> {
    // One deadline bounds queueing, process start, handshake and the search.
    const control = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      control.abort();
    }, this.options.timeoutMs);
    const onAbort = () => control.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) control.abort();
    let release: (() => void) | undefined;
    let session: McpStdioSession | undefined;
    try {
      release = await this.sessions.acquire(control.signal);
      session = await McpStdioSession.start({
        command: this.options.command,
        args: ["memory-server"],
        environment: cairnKeepChildEnvironment(this.options.environment),
        deadlineMs: this.options.timeoutMs,
        maxMessageBytes: projectMemoryLimits.responseBytes,
        maxTotalBytes: projectMemoryLimits.responseBytes * 2,
        signal: control.signal,
      });
      return await work(session);
    } catch (error) {
      if (timedOut) throw new ProjectMemoryError("PROJECT_MEMORY_TIMEOUT");
      if (signal?.aborted === true)
        throw new ProjectMemoryError("PROJECT_MEMORY_CANCELLED");
      if (error instanceof ProjectMemoryError) throw error;
      throw new ProjectMemoryError("PROJECT_MEMORY_FAILED");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      await session?.close();
      release?.();
    }
  }
}

/** Search is refused with a typed error; diagnostics explain the configuration. */
export class MisconfiguredProjectMemoryProvider implements ProjectMemoryProvider {
  constructor(
    readonly id: string,
    private readonly reason: string,
  ) {}

  search(): Promise<ProjectMemorySearch> {
    return Promise.reject(
      new ProjectMemoryError("PROJECT_MEMORY_MISCONFIGURED"),
    );
  }

  describe(): ProjectMemoryProviderDiagnostic {
    return {
      provider: this.id,
      state: "misconfigured",
      version: null,
      code: "PROJECT_MEMORY_MISCONFIGURED",
      message: this.reason,
    };
  }

  probe(): Promise<ProjectMemoryProviderDiagnostic> {
    return Promise.resolve(this.describe());
  }
}
