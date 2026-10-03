import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { WorkerContext } from "@ai-office/application/ports/worker-runtime.port.ts";
import { runWorkerProcess } from "@ai-office/agent-runtime/claude-worker-runtime.ts";
import {
  CodexWorkerRuntime,
  codexDisabledFeatures,
} from "@ai-office/agent-runtime/codex-worker-runtime.ts";
import {
  codexFeatureListing,
  createOperatorCodexHome,
  installFakeCodex,
} from "../helpers/fake-codex.ts";

const secret = "sk-operator-secret-credential";
const context: WorkerContext = {
  schemaVersion: 1,
  projectId: "project",
  runId: "run",
  task: {
    id: "task",
    title: "Review evidence",
    description: null,
    updatedAt: "2026-09-07T00:00:00.000Z",
  },
  agent: {
    id: "reviewer",
    name: "Reviewer",
    roleId: "role",
    roleKey: "reviewer",
    roleVersion: 1,
  },
  stage: null,
  memory: { results: [] },
};
const limits = {
  timeoutMs: 10000,
  maxTurns: 2,
  maxEstimatedCostUsd: "0.100000",
  maxCostMicros: 100000n,
};

describe.skipIf(process.platform === "win32")(
  "Codex worker process isolation",
  () => {
    let root: string;
    let operatorHome: string;
    let fake: ReturnType<typeof installFakeCodex>;
    let scratch: string;
    const ambient = { ...process.env };

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "ao-codex-isolation-"));
      operatorHome = createOperatorCodexHome(root, secret);
      fake = installFakeCodex(root);
      // A private temporary root makes leftover worker directories observable.
      scratch = join(root, "tmp");
      mkdirSync(scratch);
      process.env.TMPDIR = scratch;
      process.env.CODEX_HOME = operatorHome;
      process.env.OPENAI_API_KEY = "sk-ambient-provider-key";
      process.env.CODEX_API_KEY = "sk-ambient-codex-key";
      process.env.HTTPS_PROXY = "http://ambient-proxy.invalid:8080";
    });
    afterEach(() => {
      for (const name of [
        "TMPDIR",
        "CODEX_HOME",
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "HTTPS_PROXY",
      ])
        if (ambient[name] === undefined) delete process.env[name];
        else process.env[name] = ambient[name];
      rmSync(root, { recursive: true, force: true });
    });
    const worker = () => new CodexWorkerRuntime(fake.executable);
    const cleaned = () => expect(readdirSync(scratch)).toEqual([]);

    test("the child sees a private auth-only Codex home and no operator state", async () => {
      const sourceBefore = statSync(join(operatorHome, "auth.json"));
      const output = await worker().execute(context, limits);
      const report = fake.report();

      expect(Object.keys(report.env).sort()).toEqual([
        "CODEX_HOME",
        "HOME",
        "PATH",
      ]);
      expect(report.env.CODEX_HOME).not.toBe(operatorHome);
      expect(report.env.HOME).not.toBe(homedir());
      expect(dirname(report.env.CODEX_HOME!)).toBe(dirname(report.env.HOME!));
      // The child reports its resolved directory; the temporary root may be a link.
      expect(basename(dirname(report.cwd))).toBe(
        basename(dirname(report.env.HOME!)),
      );
      expect(dirname(dirname(report.cwd))).toBe(realpathSync(scratch));
      expect(report.codexHome).toEqual({ entries: ["auth.json"], mode: 0o700 });
      expect(report.home).toEqual({ entries: [], mode: 0o700 });
      expect(report.cwdEntries).toEqual(["answer.schema.json"]);
      expect(report.auth).toEqual({
        content: JSON.stringify({ OPENAI_API_KEY: secret }),
        mode: 0o600,
      });
      expect(report.prompt).not.toContain("AMBIENT");

      const flag = (name: string) =>
        report.args.some(
          (value, index) =>
            value === name && report.args[index - 1] === "--disable",
        );
      expect(flag("view_image")).toBe(true);
      expect(codexDisabledFeatures.every(flag)).toBe(true);

      // The operator's login is read, never rewritten or moved.
      const sourceAfter = statSync(join(operatorHome, "auth.json"));
      expect(sourceAfter.mtimeMs).toBe(sourceBefore.mtimeMs);
      expect(sourceAfter.ino).toBe(sourceBefore.ino);
      expect(readdirSync(operatorHome).sort()).toEqual([
        "AGENTS.md",
        "AGENTS.override.md",
        "auth.json",
        "config.toml",
        "history.jsonl",
        "skills",
      ]);

      expect(output).toMatchObject({ summary: "Codex analysis", model: null });
      expect(JSON.stringify(output)).not.toContain(secret);
      expect(existsSync(report.env.CODEX_HOME!)).toBe(false);
      cleaned();
    });

    test("a failing client is cleaned up and never echoes the credential", async () => {
      fake.setMode("fail");
      const failure = await worker()
        .execute(context, limits)
        .then(
          () => new Error("the worker unexpectedly succeeded"),
          (error: unknown) => error as Error,
        );
      expect(failure).toMatchObject({ code: "WORKER_FAILED" });
      expect(`${failure.message} ${failure.stack}`).not.toContain(secret);
      expect(`${failure.message} ${failure.stack}`).not.toContain(operatorHome);
      expect(existsSync(fake.report().env.CODEX_HOME!)).toBe(false);
      cleaned();
    });

    test("deadline and cancellation remove the isolated home", async () => {
      fake.setMode("hang");
      await expect(
        worker().execute(context, { ...limits, timeoutMs: 1500 }),
      ).rejects.toMatchObject({ code: "WORKER_TIMEOUT" });
      expect(existsSync(fake.report().env.CODEX_HOME!)).toBe(false);
      cleaned();

      const control = new AbortController();
      const execution = worker().execute(context, limits, control.signal);
      const settled = expect(execution).rejects.toMatchObject({
        name: "AbortError",
      });
      rmSync(join(root, "codex-report.json"));
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (existsSync(join(root, "codex-report.json"))) break;
        await Bun.sleep(10);
      }
      expect(readdirSync(scratch)).toHaveLength(1);
      control.abort();
      await settled;
      cleaned();
    });

    test("a tool event from the client fails the run closed", async () => {
      fake.setMode("tool");
      await expect(worker().execute(context, limits)).rejects.toMatchObject({
        code: "WORKER_OUTPUT_INVALID",
      });
      cleaned();
    });

    test("missing or unusable authentication never falls back to the operator home", async () => {
      const refused = async () => {
        writeFileSync(join(root, "codex-report.json"), "null");
        await expect(worker().execute(context, limits)).rejects.toMatchObject({
          code: "WORKER_UNAVAILABLE",
        });
        // The client was never started for the task.
        expect(readFileSync(join(root, "codex-report.json"), "utf8")).toBe(
          "null",
        );
        cleaned();
      };
      const auth = join(operatorHome, "auth.json");

      writeFileSync(auth, "not json");
      await refused();
      writeFileSync(auth, "[]");
      await refused();
      writeFileSync(auth, "");
      await refused();
      writeFileSync(auth, "x".repeat(64 * 1024 + 1));
      await refused();
      rmSync(auth);
      await refused();
      // A keyring login leaves no file; a link is never followed.
      writeFileSync(join(root, "elsewhere.json"), "{}");
      symlinkSync(join(root, "elsewhere.json"), auth);
      await refused();
      process.env.CODEX_HOME = "relative/codex-home";
      await refused();
    });

    test("a client whose features cannot express the isolation is unavailable", async () => {
      const refused = async (listing: string) => {
        fake.setFeatureListing(listing);
        await expect(worker().execute(context, limits)).rejects.toMatchObject({
          code: "WORKER_UNAVAILABLE",
        });
        cleaned();
      };
      // A newer client ships a default-enabled capability this worker never audited.
      await refused(codexFeatureListing + "file_reader  stable  true\n");
      // The supported client no longer knows a feature the worker must disable.
      await refused(
        codexFeatureListing
          .split("\n")
          .filter((line) => !line.startsWith("view_image "))
          .join("\n"),
      );
    });

    test("the shared runner gives the Claude worker no Codex state", async () => {
      const printed = await runWorkerProcess({
        executable: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        cwd: root,
        input: "",
        timeoutMs: 10000,
      });
      const inherited = JSON.parse(printed) as Record<string, string>;
      expect(inherited.CODEX_HOME).toBeUndefined();
      expect(inherited.OPENAI_API_KEY).toBeUndefined();
      expect(inherited.PATH).toBe(process.env.PATH);
    });
  },
);
