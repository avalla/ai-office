import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runRuntimeCli } from "../../apps/cli/src/daemon-cli.ts";
import type { CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";

const temporaryDirectories: string[] = [];

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
    stdout,
    stderr,
  };
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** A repository whose contents are recognisable in a scan summary. */
function repository(prefix: string, marker: string): string {
  const root = temporaryDirectory(prefix);
  writeFileSync(join(root, "README.md"), `# ${marker}`);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: marker, devDependencies: { vitest: "latest" } }),
  );
  writeFileSync(join(root, `${marker}.ts`), "export const value = 1;");
  return root;
}

async function waitForDaemon(socketPath: string): Promise<void> {
  const client = new DaemonClient(socketPath);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await client.health();
      return;
    } catch {
      await Bun.sleep(5);
    }
  }
  throw new Error("Runtime host did not become healthy");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("caller-local filesystem paths across the Runtime boundary", () => {
  test("a relative path means the client's directory, never the persistent host's", async () => {
    // Directory A hosts the Runtime; directory B is where the operator runs
    // the CLI. Both the host's composition root and its process working
    // directory point at A, so an implementation that resolved "." itself
    // would scan A.
    const hostRoot = repository("ai-office-host-a-", "hostrepo");
    const callerRoot = repository("ai-office-caller-b-", "callerrepo");
    const socketPath = join(hostRoot, "daemon.sock");
    const previousWorkingDirectory = process.cwd();
    const daemon = await bootstrap({ projectRoot: hostRoot, socketPath });
    const controller = new AbortController();
    process.chdir(hostRoot);
    const running = daemon.start(controller.signal);

    try {
      await waitForDaemon(socketPath);
      const output = captureIo();

      expect(
        await runRuntimeCli(["project:import", ".", "--json"], {
          projectRoot: hostRoot,
          workingDirectory: callerRoot,
          socketPath,
          io: output.io,
        }),
      ).toBe(0);

      const imported = JSON.parse(output.stdout[0]!) as {
        scan: { rootPath: string; projectName?: string };
      };
      expect(imported.scan.rootPath).toContain("ai-office-caller-b-");
      expect(imported.scan.rootPath).not.toContain("ai-office-host-a-");

      // The same relative argument from the host's own directory must select
      // the host repository, proving the client context is what decided.
      const fromHost = captureIo();
      expect(
        await runRuntimeCli(["project:import", ".", "--json"], {
          projectRoot: hostRoot,
          workingDirectory: hostRoot,
          socketPath,
          io: fromHost.io,
        }),
      ).toBe(0);
      const hostImport = JSON.parse(fromHost.stdout[0]!) as {
        scan: { rootPath: string };
      };
      expect(hostImport.scan.rootPath).toContain("ai-office-host-a-");
    } finally {
      process.chdir(previousWorkingDirectory);
      controller.abort();
      await running;
    }
  });

  test("path-bearing commands resolve in the caller's directory", async () => {
    const hostRoot = repository("ai-office-host-a-", "hostrepo");
    const callerRoot = repository("ai-office-caller-b-", "callerrepo");
    mkdirSync(join(callerRoot, "agents", "reviewer"), { recursive: true });
    writeFileSync(
      join(callerRoot, "agents", "reviewer", "agent.yaml"),
      [
        "id: reviewer",
        "role_key: code-reviewer",
        "role: code-reviewer",
        "version: 1",
        "capabilities:",
        "  - inspect_diff",
        "tools:",
        "  - git.diff",
        "model_policy: balanced",
        "limits:",
        "  max_iterations: 5",
        '  max_cost_micros: "1000000"',
        "  timeout_seconds: 900",
      ].join("\n"),
    );
    const socketPath = join(hostRoot, "daemon.sock");
    const previousWorkingDirectory = process.cwd();
    const daemon = await bootstrap({ projectRoot: hostRoot, socketPath });
    const controller = new AbortController();
    process.chdir(hostRoot);
    const running = daemon.start(controller.signal);

    const run = async (args: string[]) => {
      const output = captureIo();
      const code = await runRuntimeCli(args, {
        projectRoot: hostRoot,
        workingDirectory: callerRoot,
        socketPath,
        io: output.io,
      });
      return { code, ...output };
    };

    try {
      await waitForDaemon(socketPath);

      const imported = await run(["project:import", ".", "--json"]);
      expect(imported.code).toBe(0);
      const projectId = (
        JSON.parse(imported.stdout[0]!) as { projectId: string }
      ).projectId;

      // client:inspect --root
      const inspected = await run([
        "client:inspect",
        "--client",
        "claude",
        "--root",
        ".",
      ]);
      expect(inspected.code).toBe(0);
      expect(inspected.stdout[0]).toContain(callerRoot);
      expect(inspected.stdout[0]).not.toContain(hostRoot);

      // project:backup --output, written in the caller's directory
      const backup = await run([
        "project:backup",
        "--project",
        projectId,
        "--output",
        "backup.aioffice",
      ]);
      expect(backup.code).toBe(0);
      expect(existsSync(join(callerRoot, "backup.aioffice"))).toBe(true);
      expect(existsSync(join(hostRoot, "backup.aioffice"))).toBe(false);

      // office:apply --file, read from the caller's directory
      writeFileSync(
        join(callerRoot, "office.json"),
        JSON.stringify(officeManifest()),
      );
      const applied = await run([
        "office:apply",
        "--project",
        projectId,
        "--file",
        "office.json",
      ]);
      expect(applied.code).toBe(0);
      expect(JSON.parse(applied.stdout[0]!)).toMatchObject({ revision: 1 });

      // A manifest that exists only beside the host must not be found.
      writeFileSync(
        join(hostRoot, "host-only.json"),
        JSON.stringify(officeManifest()),
      );
      const hostOnly = await run([
        "office:apply",
        "--project",
        projectId,
        "--file",
        "host-only.json",
      ]);
      expect(hostOnly.code).toBe(1);
      expect(hostOnly.stdout).toEqual([]);
      expect(hostOnly.stderr[0]).toContain("was not found");

      // agent:sync --directory, defaulted from the caller's directory
      const synced = await run(["agent:sync", "--project", projectId]);
      expect(synced.code).toBe(0);
      expect(synced.stdout).toEqual(["Agent definitions synchronized: 1"]);

      // status [path]
      const status = await run(["status", ".", "--json"]);
      const statusJson = JSON.parse(status.stdout[0]!) as {
        project: { root: string };
      };
      expect(statusJson.project.root).toContain("ai-office-caller-b-");
    } finally {
      process.chdir(previousWorkingDirectory);
      controller.abort();
      await running;
    }
  });

  test("the Runtime enforces canonical manifest containment independently of client and host cwd", async () => {
    const hostRoot = repository("ai-office-manifest-host-", "host");
    const root = repository("ai-office-manifest-project-", "project");
    const src = join(root, "src");
    mkdirSync(src);
    mkdirSync(join(root, ".git")); // Nearest repository root for validate.
    const manifest = JSON.stringify(officeManifest());
    writeFileSync(join(root, "office.json"), manifest);
    writeFileSync(join(hostRoot, "outside.json"), manifest);
    symlinkSync(join(hostRoot, "outside.json"), join(root, "escape.json"));
    symlinkSync(join(root, "office.json"), join(root, "inside-link.json"));
    writeFileSync(join(root, "oversize.json"), " ".repeat(256 * 1024 + 1));
    const socketPath = join(hostRoot, "daemon.sock");
    const daemon = await bootstrap({ projectRoot: hostRoot, socketPath });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    try {
      await waitForDaemon(socketPath);
      const client = new DaemonClient(socketPath);
      const imported = await client.execute(["project:import", root, "--json"]);
      expect(imported.exitCode).toBe(0);
      const { projectId } = JSON.parse(imported.stdout[0]!) as {
        projectId: string;
      };
      const apply = (file: string) =>
        client.execute([
          "office:apply",
          "--project",
          projectId,
          "--file",
          file,
        ]);
      expect((await apply(join(root, "office.json"))).exitCode).toBe(0);
      expect((await apply(join(root, "inside-link.json"))).exitCode).toBe(0);
      for (const command of ["office:apply", "office:validate"]) {
        const output = captureIo();
        expect(
          await runRuntimeCli(
            [
              command,
              "--file",
              "../office.json",
              ...(command === "office:apply" ? ["--project", projectId] : []),
            ],
            {
              projectRoot: hostRoot,
              workingDirectory: src,
              socketPath,
              io: output.io,
            },
          ),
          output.stderr.join("\n"),
        ).toBe(0);
        const prefix =
          command === "office:apply"
            ? [command, "--project", projectId]
            : [command, "--root", src];
        for (const file of [
          join(root, "escape.json"),
          join(hostRoot, "outside.json"),
          root + "/../" + hostRoot.split("/").at(-1) + "/outside.json",
        ]) {
          const result = await client.execute([...prefix, "--file", file]);
          expect(result.exitCode).toBe(1);
          expect(result.stderr[0]).toContain("must be inside the project root");
        }
        const directory = await client.execute([...prefix, "--file", src]);
        expect(directory.stderr[0]).toContain("regular file");
        const oversize = await client.execute([
          ...prefix,
          "--file",
          join(root, "oversize.json"),
        ]);
        expect(oversize.stderr[0]).toContain("262144-byte limit");
      }
      // A valid nested binding takes precedence over the enclosing Git root.
      mkdirSync(join(src, ".ai-office"));
      writeFileSync(
        join(src, ".ai-office", "project.json"),
        JSON.stringify({
          schemaVersion: 2,
          managedBy: "ai-office",
          repositoryId: "repo_nested_manifest",
        }),
      );
      writeFileSync(join(src, "nested.json"), manifest);
      expect(
        (
          await client.execute([
            "office:validate",
            "--root",
            src,
            "--file",
            join(src, "nested.json"),
          ])
        ).exitCode,
      ).toBe(0);
      const beyondBinding = await client.execute([
        "office:validate",
        "--root",
        src,
        "--file",
        join(root, "office.json"),
      ]);
      expect(beyondBinding.stderr[0]).toContain(
        "must be inside the project root",
      );
      writeFileSync(join(src, ".ai-office", "project.json"), "{}");
      expect(
        (
          await client.execute([
            "office:validate",
            "--root",
            src,
            "--file",
            join(src, "nested.json"),
          ])
        ).exitCode,
      ).toBe(1);

      // Standalone validate uses the explicit caller directory, with no host fallback.
      const standalone = repository(
        "ai-office-manifest-standalone-",
        "standalone",
      );
      writeFileSync(join(standalone, "office.json"), manifest);
      const valid = await client.execute([
        "office:validate",
        "--root",
        standalone,
        "--file",
        join(standalone, "office.json"),
      ]);
      expect(valid.exitCode).toBe(0);
      const invalid = await client.execute([
        "office:validate",
        "--root",
        standalone,
        "--file",
        join(hostRoot, "outside.json"),
      ]);
      expect(invalid.stderr[0]).toContain("must be inside the project root");
    } finally {
      controller.abort();
      await running;
    }
  });

  test("the Runtime refuses a caller-local path it would have to guess", async () => {
    const hostRoot = repository("ai-office-host-a-", "hostrepo");
    const socketPath = join(hostRoot, "daemon.sock");
    const daemon = await bootstrap({ projectRoot: hostRoot, socketPath });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);

    try {
      await waitForDaemon(socketPath);
      const client = new DaemonClient(socketPath);

      // Bypassing the client boundary is the only way a relative caller-local
      // path can reach the Runtime, and the Runtime rejects it rather than
      // resolving it against its own working directory.
      const imported = await client.execute(["project:import", "."]);
      expect(imported.exitCode).toBe(1);
      expect(imported.stdout).toEqual([]);
      expect(imported.stderr[0]).toContain("must be an absolute path");
      expect(imported.stderr[0]).toContain(
        "never interprets a relative path against its own working directory",
      );

      const inspected = await client.execute([
        "client:inspect",
        "--client",
        "claude",
        "--root",
        "some/relative/root",
      ]);
      expect(inspected.exitCode).toBe(1);
      expect(inspected.stderr[0]).toContain("Option --root");

      for (const args of [
        ["install"],
        ["status"],
        ["next"],
        ["uninstall"],
        ["project:import"],
        ["project:restore", join(hostRoot, "archive.aioffice")],
        ["agent:sync", "--project", "p1"],
        ["office:validate", "--file", join(hostRoot, "office.json")],
      ]) {
        const response = await client.execute(args);
        expect(response.exitCode, args.join(" ")).toBe(1);
        expect(response.stdout).toEqual([]);
        expect(response.stderr[0]).toContain(
          "must be an absolute path resolved by the calling client",
        );
        expect(response.stderr[0]).toContain('received "omitted"');
      }

      // An absolute path is accepted and interpreted exactly as given.
      const absolute = await client.execute([
        "project:import",
        hostRoot,
        "--json",
      ]);
      expect(absolute.exitCode).toBe(0);
    } finally {
      controller.abort();
      await running;
    }
  });
});

/** The shipped baseline is the simplest manifest the Runtime already accepts. */
function officeManifest(): unknown {
  return JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        ".agents",
        "skills",
        "ai-office",
        "assets",
        "default-office-manifest.json",
      ),
      "utf8",
    ),
  ) as unknown;
}
