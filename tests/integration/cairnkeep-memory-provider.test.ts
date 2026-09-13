import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  CairnKeepMemoryProvider,
  supportedMcpProtocolVersions,
} from "@ai-office/cairnkeep-memory/cairnkeep-memory-provider.ts";
import { createProjectMemoryProvider } from "@ai-office/cairnkeep-memory/create-project-memory-provider.ts";
import { deriveProjectMemoryIdentity } from "@ai-office/application/project-memory/project-memory-identity.ts";
import { projectMemoryLimits } from "@ai-office/application/ports/project-memory-provider.port.ts";
import {
  createFakeCairnKeep,
  processAlive,
  type FakeCairnKeepOptions,
} from "../helpers/fake-cairnkeep.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

const identity = deriveProjectMemoryIdentity("repo_integration");
const environment = {
  PATH: process.env.PATH,
  HOME: "/home/fixture",
  AI_OFFICE_PROVIDER_SECRET: "must-not-leak",
  CAIRN_LLM_API_KEY: "must-not-leak",
  MCP_HTTP_PORT: "8080",
  CAIRN_MCP_TOOL_PROFILE: "full",
};

function provider(options: FakeCairnKeepOptions = {}, timeoutMs = 3_000) {
  const fake = createFakeCairnKeep(options);
  cleanup.push(fake.cleanup);
  return {
    fake,
    provider: new CairnKeepMemoryProvider({
      command: fake.command,
      timeoutMs,
      environment,
    }),
  };
}

const search = (value: CairnKeepMemoryProvider, signal?: AbortSignal) =>
  value.search({
    identity,
    text: "Refactor the authentication middleware",
    limit: projectMemoryLimits.maxResults,
    ...(signal === undefined ? {} : { signal }),
  });

test("one bounded project-scoped search over the real stdio transport returns normalized hits", async () => {
  const { fake, provider: cairn } = provider({
    results: [
      { key: "notes/b", value: "second", score: 0.5 },
      { key: "notes/a", value: "first", score: 0.5 },
      { key: "notes/top", value: "top ".repeat(400), score: 0.9 },
    ],
  });
  const result = await search(cairn);
  expect(result.provider).toEqual({ id: "cairnkeep", version: "0.1.0" });
  // The digest names the exact outbound query, not the application query.
  expect(result.providerQuerySha256).toBe(
    createHash("sha256").update("authentication", "utf8").digest("hex"),
  );
  expect(result.hits.map((hit) => hit.referenceId)).toEqual([
    "notes/top",
    "notes/a",
    "notes/b",
  ]);
  expect(result.hits[0]).toMatchObject({
    scope: identity.memoryProjectId,
    truncated: true,
    contentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
  });
  expect([...result.hits[0]!.excerpt].length).toBe(
    projectMemoryLimits.excerptCharacters,
  );

  const log = fake.log();
  const starts = log.filter((entry) => entry.kind === "start");
  expect(starts).toHaveLength(1);
  expect(starts[0]!.args).toEqual(["memory-server"]);
  // A private temporary directory: never a repository checkout.
  expect(starts[0]!.cwd).toMatch(/ai-office-memory-/);
  expect(existsSync(starts[0]!.cwd!)).toBe(false);
  expect(starts[0]!.environment).toMatchObject({
    CAIRN_MCP_TOOL_PROFILE: "custom",
    CAIRN_MCP_ALLOWED_TOOLS: "memory_search",
    HOME: "/home/fixture",
  });
  const inherited = Object.keys(starts[0]!.environment!).filter(
    (name) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(name),
  );
  for (const name of inherited)
    expect([
      "PATH",
      "HOME",
      "CAIRN_MCP_TOOL_PROFILE",
      "CAIRN_MCP_ALLOWED_TOOLS",
    ]).toContain(name);

  const requests = log.filter((entry) => entry.kind === "request");
  expect(requests.map((entry) => entry.method)).toEqual([
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/call",
  ]);
  expect(requests[0]!.params).toMatchObject({
    protocolVersion: "2025-06-18",
  });
  expect(requests[3]!.params).toEqual({
    name: "memory_search",
    arguments: {
      scope: identity.memoryProjectId,
      query: "authentication",
      top_k: 5,
    },
  });
});

test("the client supports exactly the MCP protocol revision it implements", () => {
  expect(supportedMcpProtocolVersions).toEqual(["2025-06-18"]);
});

test.each([
  ["an older", "2024-11-05"],
  ["a newer", "2099-01-01"],
  ["a malformed", 20250618],
  ["a missing", null],
])(
  "%s initialize protocol version is incompatible and nothing follows it",
  async (_label, protocolVersion) => {
    const { fake, provider: cairn } = provider({
      protocolVersion,
      results: [{ key: "k", value: "v", score: 1 }],
    });
    await expect(search(cairn)).rejects.toMatchObject({
      name: "ProjectMemoryError",
      code: "PROJECT_MEMORY_INCOMPATIBLE",
    });
    expect(
      fake
        .log()
        .filter((entry) => entry.kind === "request")
        .map((entry) => entry.method),
    ).toEqual(["initialize"]);
    expect(await cairn.probe()).toMatchObject({
      state: "unavailable",
      code: "PROJECT_MEMORY_INCOMPATIBLE",
    });
    expect(
      fake
        .log()
        .filter((entry) => entry.kind === "request")
        .map((entry) => entry.method),
    ).toEqual(["initialize", "initialize"]);
  },
);

test("the child receives only the normalized absolute CairnKeep base directory", async () => {
  const fake = createFakeCairnKeep({ results: [] });
  cleanup.push(fake.cleanup);
  const hostEnvironment = {
    PATH: process.env.PATH,
    HOME: "/home/fixture",
    AI_OFFICE_PROJECT_MEMORY_PROVIDER: "cairnkeep",
    AI_OFFICE_CAIRNKEEP_COMMAND: fake.command,
    CAIRN_AGENTFS_BASE_DIR: "~/stores//cairn/../cairnkeep/",
  };
  await createProjectMemoryProvider(hostEnvironment, "linux").search({
    identity,
    text: "Refactor the authentication middleware",
    limit: 1,
  });
  const configured = createProjectMemoryProvider(
    { ...hostEnvironment, CAIRN_AGENTFS_BASE_DIR: "/srv/cairn/./store" },
    "linux",
  );
  await configured.search({ identity, text: "authentication", limit: 1 });
  const unset = { ...hostEnvironment } as Record<string, string | undefined>;
  delete unset.CAIRN_AGENTFS_BASE_DIR;
  await createProjectMemoryProvider(unset, "linux").search({
    identity,
    text: "authentication",
    limit: 1,
  });
  const starts = fake.log().filter((entry) => entry.kind === "start");
  expect(
    starts.map((entry) => entry.environment?.CAIRN_AGENTFS_BASE_DIR),
  ).toEqual(["/home/fixture/stores/cairnkeep", "/srv/cairn/store", undefined]);

  // A relative value is refused before any process starts.
  const relative = createProjectMemoryProvider(
    { ...hostEnvironment, CAIRN_AGENTFS_BASE_DIR: ".cairnkeep" },
    "linux",
  );
  expect(relative.describe()).toMatchObject({
    state: "misconfigured",
    code: "PROJECT_MEMORY_MISCONFIGURED",
  });
  expect(relative.describe().message).not.toContain(".cairnkeep");
  await expect(
    relative.search({ identity, text: "authentication", limit: 1 }),
  ).rejects.toMatchObject({ code: "PROJECT_MEMORY_MISCONFIGURED" });
  expect(fake.log().filter((entry) => entry.kind === "start")).toHaveLength(3);
});

test("an empty result is a successful search with no hits", async () => {
  const { provider: cairn } = provider({ results: [] });
  expect((await search(cairn)).hits).toEqual([]);
});

test.each([
  ["extra-tools", "PROJECT_MEMORY_INCOMPATIBLE"],
  ["wrong-server", "PROJECT_MEMORY_INCOMPATIBLE"],
  ["stdout-noise", "PROJECT_MEMORY_INVALID_RESPONSE"],
  ["malformed-result", "PROJECT_MEMORY_INVALID_RESPONSE"],
  ["oversized", "PROJECT_MEMORY_RESPONSE_TOO_LARGE"],
  ["tool-error", "PROJECT_MEMORY_FAILED"],
  ["exit-on-start", "PROJECT_MEMORY_UNAVAILABLE"],
] as const)(
  "%s fails closed as %s without provider text",
  async (mode, code) => {
    const { fake, provider: cairn } = provider({
      mode,
      results: [{ key: "k", value: "v", score: 1 }],
    });
    const error = await search(cairn).catch((value: unknown) => value);
    expect(error).toMatchObject({ name: "ProjectMemoryError", code });
    expect(String((error as Error).message)).not.toContain("/secret/path");
    if (mode === "extra-tools")
      // A server that exposes a mutation tool is never asked to do anything.
      expect(
        fake.log().filter((entry) => entry.method === "tools/call"),
      ).toEqual([]);
  },
);

test("a result for another scope is rejected, never injected", async () => {
  const { provider: cairn } = provider({
    results: [{ key: "k", value: "v", score: 1, scope: "identity" }],
  });
  await expect(search(cairn)).rejects.toMatchObject({
    code: "PROJECT_MEMORY_INVALID_RESPONSE",
  });
});

test("a missing executable is unavailable", async () => {
  const cairn = new CairnKeepMemoryProvider({
    command: "/nonexistent/ai-office-test/cairn",
    timeoutMs: 2_000,
    environment,
  });
  await expect(search(cairn)).rejects.toMatchObject({
    code: "PROJECT_MEMORY_UNAVAILABLE",
  });
});

test("a hanging server times out within its bound and its whole process group is reaped", async () => {
  const { fake, provider: cairn } = provider(
    { mode: "hang-with-grandchild" },
    400,
  );
  const started = Date.now();
  await expect(search(cairn)).rejects.toMatchObject({
    code: "PROJECT_MEMORY_TIMEOUT",
  });
  expect(Date.now() - started).toBeLessThan(5_000);
  const grandchild = fake.log().find((entry) => entry.kind === "grandchild");
  expect(grandchild?.pid).toBeTypeOf("number");
  expect(processAlive(grandchild!.pid!)).toBe(false);
});

test("cleanup is bounded even when a helper escaped the process group and holds the pipes", async () => {
  const { fake, provider: cairn } = provider(
    { mode: "hang-with-escaped-helper" },
    300,
  );
  const started = Date.now();
  try {
    await expect(search(cairn)).rejects.toMatchObject({
      code: "PROJECT_MEMORY_TIMEOUT",
    });
    // Grace, bounded exit wait and group polling: never unbounded.
    expect(Date.now() - started).toBeLessThan(8_000);
    // The permit was released: a following search is not starved.
    await expect(search(cairn)).rejects.toMatchObject({
      code: "PROJECT_MEMORY_TIMEOUT",
    });
    expect(Date.now() - started).toBeLessThan(16_000);
  } finally {
    for (const entry of fake.log())
      if (entry.kind === "grandchild" && entry.pid !== undefined)
        try {
          process.kill(entry.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
  }
}, 30_000);

test("cancellation stops the provider promptly", async () => {
  const { provider: cairn } = provider({ mode: "hang" }, 10_000);
  const controller = new AbortController();
  const pending = search(cairn, controller.signal);
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  await expect(pending).rejects.toMatchObject({
    code: "PROJECT_MEMORY_CANCELLED",
  });
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("probe distinguishes available and unavailable without searching", async () => {
  const available = provider({ results: [{ key: "k", value: "v", score: 1 }] });
  expect(await available.provider.probe()).toMatchObject({
    state: "available",
    version: "0.1.0",
    code: null,
  });
  expect(
    available.fake.log().some((entry) => entry.method === "tools/call"),
  ).toBe(false);
  const incompatible = provider({ mode: "extra-tools" });
  expect(await incompatible.provider.probe()).toMatchObject({
    state: "unavailable",
    code: "PROJECT_MEMORY_INCOMPATIBLE",
  });
});

test("the factory is disabled by default and never starts a process", async () => {
  const disabled = createProjectMemoryProvider({}, "linux");
  expect(disabled.describe().state).toBe("disabled");
  const fake = createFakeCairnKeep();
  cleanup.push(fake.cleanup);
  const configured = createProjectMemoryProvider(
    {
      AI_OFFICE_PROJECT_MEMORY_PROVIDER: "cairnkeep",
      AI_OFFICE_CAIRNKEEP_COMMAND: fake.command,
    },
    "linux",
  );
  expect(configured.describe().state).toBe("configured");
  expect(fake.log()).toEqual([]);
  expect(
    createProjectMemoryProvider(
      { AI_OFFICE_PROJECT_MEMORY_PROVIDER: "cairnkeep" },
      "win32",
    ).describe().state,
  ).toBe("misconfigured");
});
