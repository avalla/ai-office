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
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { WorkerContext } from "@ai-office/application/ports/worker-runtime.port.ts";
import { runWorkerProcess } from "@ai-office/agent-runtime/claude-worker-runtime.ts";
import {
  CodexWorkerRuntime,
  codexDisabledFeatures,
  codexRefreshBlockedUrl,
  parseCodexWorkerOutput,
} from "@ai-office/agent-runtime/codex-worker-runtime.ts";
import {
  codexFeatureListing,
  codexLogin,
  codexToken,
  createOperatorCodexHome,
  installFakeCodex,
  managedBundlePlans,
  multiAgentV2Models,
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
    // Unrouted runs name the model; only an audited bounded one is accepted.
    const worker = () =>
      new CodexWorkerRuntime(fake.executable, undefined, "gpt-5.5");
    const cleaned = () => expect(readdirSync(scratch)).toEqual([]);

    test("the child sees a private auth-only Codex home and no operator state", async () => {
      const sourceBefore = statSync(join(operatorHome, "auth.json"));
      const output = await worker().execute(context, limits);
      const report = fake.report();

      expect(Object.keys(report.env).sort()).toEqual([
        "CODEX_HOME",
        "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
        "HOME",
        "PATH",
      ]);
      expect(report.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE).toBe(
        "http://127.0.0.1:0/ai-office-refresh-disabled",
      );
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
        content: readFileSync(join(operatorHome, "auth.json"), "utf8"),
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

      expect(output).toMatchObject({
        summary: "Codex analysis",
        model: "gpt-5.5",
      });
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

    test("project state in an ancestor of the temporary tree never reaches the worker", async () => {
      // The temporary root lives inside a directory that looks like a project.
      mkdirSync(join(root, ".agents", "skills", "ambient-a"), {
        recursive: true,
      });
      mkdirSync(join(root, ".codex", "skills", "ambient-c"), {
        recursive: true,
      });
      for (const skill of [
        ".agents/skills/ambient-a",
        ".codex/skills/ambient-c",
      ])
        writeFileSync(
          join(root, skill, "SKILL.md"),
          "---\nname: ambient\ndescription: AMBIENT PROJECT SKILL\n---\n",
        );
      writeFileSync(join(root, "AGENTS.md"), "AMBIENT PROJECT INSTRUCTIONS");
      writeFileSync(
        join(root, ".codex", "config.toml"),
        "[features]\nshell_tool = true\nview_image = true\n",
      );
      const marker = join(root, ".git");
      for (const create of [
        () => mkdirSync(marker),
        () => writeFileSync(join(marker, "HEAD"), "ref: refs/heads/main\n"),
        () => {
          rmSync(marker, { recursive: true });
          writeFileSync(marker, "");
        },
      ]) {
        create();
        // Control: without the worker's configuration the audited CLI finds
        // the ancestor root and loads both skill directories.
        const work = join(scratch, "control");
        mkdirSync(work);
        await runWorkerProcess({
          executable: fake.executable,
          args: ["exec", "-"],
          cwd: work,
          input: "",
          timeoutMs: 10000,
          env: { PATH: process.env.PATH ?? "", HOME: work, CODEX_HOME: work },
        });
        // The child reports resolved paths; the temporary root may be a link.
        expect(fake.report().projectSkills).toEqual([
          join(realpathSync(root), ".agents", "skills", "ambient-a"),
          join(realpathSync(root), ".codex", "skills", "ambient-c"),
        ]);
        rmSync(work, { recursive: true });

        await worker().execute(context, limits);
        const report = fake.report();
        expect(report.cwd.startsWith(realpathSync(root))).toBe(true);
        expect(report.projectSkills).toEqual([]);
        expect(report.args).toContain("project_root_markers=[]");
        expect(report.args).toContain("project_doc_max_bytes=0");
        expect(report.args).toContain("skills.bundled.enabled=false");
        expect(report.prompt).not.toContain("AMBIENT");
        cleaned();
      }
    });

    test("a descendant that outlives a successful client is reaped before cleanup", async () => {
      fake.setMode("linger");
      const output = await worker().execute(context, limits);
      expect(output.summary).toBe("Codex analysis");
      // The helper kept writing into the isolated home; it is already dead
      // and the tree, login copy included, is gone.
      expect(() => process.kill(fake.helperPid(), 0)).toThrow();
      expect(existsSync(fake.report().env.CODEX_HOME!)).toBe(false);
      await Bun.sleep(50);
      cleaned();
    });

    test("a recovered reconnect is accepted and an abandoned one is not", async () => {
      fake.setMode("reconnect");
      expect(await worker().execute(context, limits)).toMatchObject({
        summary: "Codex analysis",
        usage: { inputTokens: 5, outputTokens: 7 },
      });
      fake.setMode("gave-up");
      await expect(worker().execute(context, limits)).rejects.toMatchObject({
        code: "WORKER_FAILED",
      });
      cleaned();
    });

    test("an auth.json that is not a regular file is refused without blocking", async () => {
      const auth = join(operatorHome, "auth.json");
      const refusedQuickly = async () => {
        writeFileSync(join(root, "codex-report.json"), "null");
        const started = Date.now();
        // A blocked open would outlive both the deadline and the cancellation.
        const control = new AbortController();
        const timer = setTimeout(() => control.abort(), 3000);
        try {
          await expect(
            worker().execute(
              context,
              { ...limits, timeoutMs: 3000 },
              control.signal,
            ),
          ).rejects.toMatchObject({ code: "WORKER_UNAVAILABLE" });
        } finally {
          clearTimeout(timer);
        }
        expect(Date.now() - started).toBeLessThan(2500);
        expect(readFileSync(join(root, "codex-report.json"), "utf8")).toBe(
          "null",
        );
        cleaned();
      };
      rmSync(auth);
      execFileSync("mkfifo", [auth]);
      await refusedQuickly();
      rmSync(auth);
      mkdirSync(auth);
      await refusedQuickly();
      rmSync(auth, { recursive: true });
      // A socket where the path is short enough for the platform to bind one.
      const server = createServer();
      const bound = await new Promise<boolean>((resolve) => {
        server.once("error", () => resolve(false));
        server.listen(auth, () => resolve(true));
      });
      if (bound) {
        try {
          await refusedQuickly();
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      }
      rmSync(auth, { force: true });
      symlinkSync("/dev/zero", auth);
      await refusedQuickly();
    });

    test("a managed-workspace login is refused before Codex can fetch or apply its configuration", async () => {
      // A stand-in ChatGPT backend whose workspace bundle defines an MCP
      // server; started, that server leaves a file behind.
      const sideEffect = join(root, "mcp-side-effect");
      let bundleRequests = 0;
      const backend = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => {
          if (new URL(request.url).pathname.endsWith("/wham/config/bundle"))
            bundleRequests += 1;
          return Response.json({
            config_toml: {
              enterprise_managed: [
                {
                  id: "fragment",
                  name: "fragment",
                  contents: [
                    "[mcp_servers.managed]",
                    `command = ${JSON.stringify(process.execPath)}`,
                    `args = ${JSON.stringify(["-e", `require("node:fs").writeFileSync(${JSON.stringify(sideEffect)}, "started")`])}`,
                  ].join("\n"),
                },
              ],
            },
            requirements_toml: { enterprise_managed: [] },
          });
        },
      });
      try {
        fake = installFakeCodex(root, `http://127.0.0.1:${backend.port}`);
        const auth = join(operatorHome, "auth.json");

        // Control: handed such a login, the client downloads the bundle and
        // starts the server. This is what the admission must prevent.
        const direct = join(scratch, "direct");
        mkdirSync(direct);
        writeFileSync(
          join(direct, "auth.json"),
          codexLogin("enterprise", secret),
        );
        await runWorkerProcess({
          executable: fake.executable,
          args: ["features", "list"],
          cwd: direct,
          input: "",
          timeoutMs: 10000,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: direct,
            CODEX_HOME: direct,
          },
        });
        expect(bundleRequests).toBe(1);
        expect(readFileSync(sideEffect, "utf8")).toBe("started");
        rmSync(direct, { recursive: true });
        rmSync(sideEffect);
        rmSync(join(root, "codex-calls.log"));
        bundleRequests = 0;

        for (const plan of [...managedBundlePlans, "team", "plan_of_2027"]) {
          writeFileSync(auth, codexLogin(plan, secret));
          await expect(
            worker().execute(context, limits),
            plan,
          ).rejects.toMatchObject({ code: "WORKER_UNAVAILABLE" });
          await expect(worker().inspect(), plan).rejects.toMatchObject({
            code: "WORKER_UNAVAILABLE",
          });
          // No Codex process at all: nothing could fetch or apply the bundle.
          expect(fake.calls(), plan).toEqual([]);
          expect(bundleRequests, plan).toBe(0);
          expect(existsSync(sideEffect), plan).toBe(false);
          cleaned();
        }

        // A supported personal plan still takes the normal path.
        writeFileSync(auth, codexLogin("prolite", secret));
        expect(await worker().execute(context, limits)).toMatchObject({
          summary: "Codex analysis",
        });
        expect(fake.calls()).toEqual(["--version", "features", "exec"]);
        expect(bundleRequests).toBe(0);
        expect(existsSync(sideEffect)).toBe(false);
        cleaned();
      } finally {
        await backend.stop(true);
      }
    });

    test("the client can never refresh the admitted login into a managed workspace", async () => {
      // A stand-in issuer that answers a refresh with Enterprise tokens, and
      // a backend whose workspace bundle defines an MCP server.
      const sideEffect = join(root, "mcp-side-effect");
      const requests: string[] = [];
      const backend = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => {
          const path = new URL(request.url).pathname;
          requests.push(path);
          if (path === "/oauth/token")
            return Response.json({
              id_token: codexToken("enterprise"),
              access_token: codexToken("enterprise"),
              refresh_token: "refreshed",
            });
          return Response.json({
            config_toml: {
              enterprise_managed: [
                {
                  id: "fragment",
                  name: "fragment",
                  contents: [
                    "[mcp_servers.managed]",
                    `command = ${JSON.stringify(process.execPath)}`,
                    `args = ${JSON.stringify(["-e", `require("node:fs").writeFileSync(${JSON.stringify(sideEffect)}, "started")`])}`,
                  ].join("\n"),
                },
              ],
            },
            requirements_toml: { enterprise_managed: [] },
          });
        },
      });
      const origin = `http://127.0.0.1:${backend.port}`;
      const ambientOverride = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE;
      try {
        fake = installFakeCodex(root, origin);
        const auth = join(operatorHome, "auth.json");
        const expired = Math.floor(Date.now() / 1000) - 3600;
        const stale = codexLogin("plus", secret, expired);
        const reset = () => {
          requests.length = 0;
          rmSync(sideEffect, { force: true });
          rmSync(join(root, "codex-calls.log"), { force: true });
          rmSync(join(root, "codex-refresh.log"), { force: true });
        };
        const untouched = () => {
          expect(requests).toEqual([]);
          expect(existsSync(sideEffect)).toBe(false);
          cleaned();
        };

        // Control: a stale personal login that is allowed to refresh becomes
        // Enterprise, fetches the bundle and starts the MCP server.
        const direct = join(scratch, "direct");
        mkdirSync(direct);
        writeFileSync(join(direct, "auth.json"), stale);
        await runWorkerProcess({
          executable: fake.executable,
          args: ["features", "list"],
          cwd: direct,
          input: "",
          timeoutMs: 10000,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: direct,
            CODEX_HOME: direct,
          },
        });
        expect(requests).toEqual([
          "/oauth/token",
          "/backend-api/wham/config/bundle",
        ]);
        expect(fake.refreshAttempts()).toEqual([`${origin}/oauth/token`]);
        expect(readFileSync(sideEffect, "utf8")).toBe("started");
        rmSync(direct, { recursive: true });
        reset();

        // An operator-level override is not inherited by the worker's child.
        process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = `${origin}/oauth/token`;

        // 1. A stale login is refused before any Codex process.
        writeFileSync(auth, stale);
        await expect(worker().execute(context, limits)).rejects.toMatchObject({
          code: "WORKER_UNAVAILABLE",
        });
        expect(fake.calls()).toEqual([]);
        expect(fake.refreshAttempts()).toEqual([]);
        untouched();
        reset();

        // 2. Even if a stale login reached the client (here the worker's
        // clock is wrong by two hours), the refresh goes to the blocked
        // address: no new tokens, no bundle, no MCP server.
        const behind = () => Date.now() - 2 * 3600 * 1000;
        const sourceBefore = readFileSync(auth);
        await expect(
          new CodexWorkerRuntime(
            fake.executable,
            undefined,
            "gpt-5.5",
            undefined,
            undefined,
            behind,
          ).execute(context, limits),
        ).rejects.toMatchObject({ code: "WORKER_FAILED" });
        expect(fake.calls()).toEqual(["--version", "features", "exec"]);
        expect(fake.refreshAttempts()).toEqual([codexRefreshBlockedUrl]);
        expect(readFileSync(auth).equals(sourceBefore)).toBe(true);
        untouched();
        reset();

        // 3. A fresh login the provider rejects mid-run: the refresh that
        // an expiry check cannot foresee is blocked the same way.
        writeFileSync(auth, codexLogin("plus", secret));
        fake.setMode("unauthorized");
        await expect(worker().execute(context, limits)).rejects.toMatchObject({
          code: "WORKER_FAILED",
        });
        expect(fake.refreshAttempts()).toEqual([codexRefreshBlockedUrl]);
        untouched();
      } finally {
        if (ambientOverride === undefined)
          delete process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE;
        else process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = ambientOverride;
        await backend.stop(true);
      }
    });

    test("no run can start a hidden sub-agent on another model", async () => {
      // A stand-in provider that records every request the client makes.
      const provider: Record<string, string | undefined>[] = [];
      const backend = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async (request) => {
          const body = (await request.json()) as {
            model?: string;
            reasoning?: { effort?: string };
            parent?: string;
          };
          provider.push({
            model: body.model,
            effort: body.reasoning?.effort,
            parent: body.parent,
          });
          return Response.json({});
        },
      });
      try {
        fake = installFakeCodex(root, `http://127.0.0.1:${backend.port}`);
        fake.setMode("spawn");
        const direct = async (model: string, ...extra: string[]) => {
          const work = join(scratch, "direct");
          mkdirSync(work);
          const output = await runWorkerProcess({
            executable: fake.executable,
            args: ["exec", "--model", model, ...extra, "-"],
            cwd: work,
            input: "",
            timeoutMs: 10000,
            env: { PATH: process.env.PATH ?? "", HOME: work, CODEX_HOME: work },
          });
          rmSync(work, { recursive: true });
          return output;
        };
        const routed = (model: string): WorkerContext => ({
          ...context,
          model: {
            policy: "balanced",
            profile: "balanced",
            modelRef: `openai:${model}`,
            providerId: "openai",
            model,
            reasoningEffort: "low",
            maxOutputTokens: null,
            source: "role_policy",
          },
        });
        const child = { model: "gpt-6-luna", effort: "xhigh" };

        // Control: on a multi-agent model the client starts a child on
        // another model and effort, and its output looks like a clean run.
        const hidden = await direct("gpt-6-astra");
        expect(provider).toEqual([{ ...child, parent: "gpt-6-astra" }]);
        expect(hidden).not.toContain("spawn");
        expect(parseCodexWorkerOutput(hidden, "gpt-6-astra")).toMatchObject({
          summary: "Codex analysis",
          model: "gpt-6-astra",
        });
        provider.length = 0;
        rmSync(join(root, "codex-calls.log"));

        // Every multi-agent model is refused before any Codex process.
        for (const model of multiAgentV2Models) {
          await expect(
            new CodexWorkerRuntime(fake.executable).execute(
              routed(model),
              limits,
            ),
            model,
          ).rejects.toMatchObject({ code: "WORKER_MODEL_UNSUPPORTED" });
          await expect(
            new CodexWorkerRuntime(fake.executable, undefined, model).execute(
              context,
              limits,
            ),
            model,
          ).rejects.toMatchObject({ code: "WORKER_MODEL_UNSUPPORTED" });
        }
        expect(fake.calls()).toEqual([]);
        expect(provider).toEqual([]);
        cleaned();

        // Control: provider metadata can declare an admitted model
        // multi-agent too, and then the client spawns for it as well.
        fake.provideMultiAgentMetadata();
        await direct("gpt-5.5");
        expect(provider).toEqual([{ ...child, parent: "gpt-5.5" }]);
        provider.length = 0;
        rmSync(join(root, "codex-calls.log"));

        // The worker's configuration keeps the admitted model single-agent
        // whatever the metadata says: one run, one provider model.
        const output = await new CodexWorkerRuntime(fake.executable).execute(
          routed("gpt-5.5"),
          limits,
        );
        expect(output).toMatchObject({ model: "gpt-5.5" });
        expect(fake.report().args).toContain("agents.enabled=false");
        expect(fake.calls()).toEqual(["--version", "features", "exec"]);
        expect(provider).toEqual([]);
        cleaned();
      } finally {
        await backend.stop(true);
      }
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
