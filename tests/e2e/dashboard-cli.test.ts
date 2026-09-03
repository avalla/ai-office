import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import type { CliIo } from "../../apps/cli/src/cli.ts";
import {
  DashboardHostError,
  startDashboardHost,
} from "../../apps/dashboard/src/dashboard-host.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      prompt: async () => "",
    },
    stdout,
    stderr,
  };
}

async function waitForDaemon(socketPath: string): Promise<void> {
  const client = new DaemonClient(socketPath);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await client.health();
      return;
    } catch {
      await Bun.sleep(5);
    }
  }
  throw new Error("Daemon did not become healthy");
}

async function startRuntime() {
  const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-dashboard-"));
  temporaryDirectories.push(projectRoot);
  writeFileSync(join(projectRoot, "README.md"), "# Dashboard fixture");
  const socketPath = join(projectRoot, ".ai-office", "daemon.sock");
  const daemon = await bootstrap({ projectRoot, socketPath });
  const controller = new AbortController();
  const running = daemon.start(controller.signal);
  await waitForDaemon(socketPath);
  return {
    projectRoot,
    socketPath,
    client: new DaemonClient(socketPath),
    stop: async () => {
      controller.abort();
      await running;
    },
  };
}

// The bundle is built once for the host tests; the build itself is asserted
// separately so a bundling failure is reported as such rather than as a
// mysterious host failure.
const stubClientScript = "/* test bundle */";

describe("ai-office dashboard", () => {
  test("prints the loopback URL and stops when interrupted", async () => {
    const runtime = await startRuntime();
    const controller = new AbortController();
    const output = captureIo();
    const opened: string[] = [];
    try {
      const command = runDaemonCli(["dashboard", "--port", "0"], {
        projectRoot: runtime.projectRoot,
        socketPath: runtime.socketPath,
        io: output.io,
        dashboardSignal: controller.signal,
        openBrowser: async (url) => {
          opened.push(url);
        },
      });

      for (let attempt = 0; attempt < 200 && opened.length === 0; attempt += 1)
        await Bun.sleep(5);

      expect(output.stdout[0]).toBe("AI Office dashboard");
      const url = output.stdout[1]!;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+$/);
      expect(output.stdout[2]).toContain("Read-only");
      expect(opened).toEqual([url]);

      controller.abort();
      expect(await command).toBe(0);

      // The port is released with the command.
      const port = Number(new URL(url).port);
      await expect(
        fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(1000),
        }),
      ).rejects.toThrow();
    } finally {
      controller.abort();
      await runtime.stop();
    }
  });

  test("--no-open suppresses the browser and still prints the URL", async () => {
    const runtime = await startRuntime();
    const controller = new AbortController();
    const output = captureIo();
    const opened: string[] = [];
    try {
      const command = runDaemonCli(["dashboard", "--port", "0", "--no-open"], {
        projectRoot: runtime.projectRoot,
        socketPath: runtime.socketPath,
        io: output.io,
        dashboardSignal: controller.signal,
        openBrowser: async (url) => {
          opened.push(url);
        },
      });

      for (
        let attempt = 0;
        attempt < 200 && output.stdout.length < 3;
        attempt += 1
      )
        await Bun.sleep(5);

      expect(output.stdout[1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
      expect(opened).toEqual([]);
      controller.abort();
      expect(await command).toBe(0);
    } finally {
      controller.abort();
      await runtime.stop();
    }
  });

  test("reports an actionable error when the daemon is not running", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-dashboard-off-"));
    temporaryDirectories.push(projectRoot);
    const output = captureIo();

    const code = await runDaemonCli(["dashboard"], {
      projectRoot,
      socketPath: join(projectRoot, "daemon.sock"),
      io: output.io,
      dashboardSignal: AbortSignal.abort(),
    });

    expect(code).toBe(1);
    expect(output.stdout).toEqual([]);
    expect(output.stderr[0]).toContain("daemon is not available");
  });

  test("rejects an invalid port before touching the daemon", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-dashboard-bad-"));
    temporaryDirectories.push(projectRoot);
    const output = captureIo();

    const code = await runDaemonCli(["dashboard", "--port", "notaport"], {
      projectRoot,
      socketPath: join(projectRoot, "daemon.sock"),
      io: output.io,
      dashboardSignal: AbortSignal.abort(),
    });

    expect(code).toBe(1);
    expect(output.stderr[0]).toContain("Port must be an integer");
  });

  test("a failing browser opener is reported but never fatal", async () => {
    const runtime = await startRuntime();
    const controller = new AbortController();
    const output = captureIo();
    try {
      const command = runDaemonCli(["dashboard", "--port", "0"], {
        projectRoot: runtime.projectRoot,
        socketPath: runtime.socketPath,
        io: output.io,
        dashboardSignal: controller.signal,
        openBrowser: async () => {
          throw new Error("no browser here");
        },
      });

      for (
        let attempt = 0;
        attempt < 200 && output.stdout.length < 4;
        attempt += 1
      )
        await Bun.sleep(5);

      expect(output.stdout[3]).toBe("Could not open a browser automatically.");
      controller.abort();
      expect(await command).toBe(0);
    } finally {
      controller.abort();
      await runtime.stop();
    }
  });

  test("is discoverable in CLI help", async () => {
    const projectRoot = mkdtempSync(
      join(tmpdir(), "ai-office-dashboard-help-"),
    );
    temporaryDirectories.push(projectRoot);
    const output = captureIo();
    expect(
      await runDaemonCli(["--help"], {
        projectRoot,
        socketPath: join(projectRoot, "daemon.sock"),
        io: output.io,
      }),
    ).toBe(0);
    expect(output.stdout.join("\n")).toContain("dashboard [--port <port>]");
  });
});

describe("dashboard loopback host", () => {
  async function withHost(
    run: (context: {
      host: Awaited<ReturnType<typeof startDashboardHost>>;
      client: DaemonClient;
      get: (path: string, init?: RequestInit) => Promise<Response>;
    }) => Promise<void>,
  ): Promise<void> {
    const runtime = await startRuntime();
    const host = await startDashboardHost({
      socketPath: runtime.socketPath,
      port: 0,
      clientScript: stubClientScript,
    });
    try {
      await run({
        host,
        client: runtime.client,
        get: (path, init) =>
          fetch(`http://127.0.0.1:${host.port}${path}`, {
            ...init,
            signal: init?.signal ?? AbortSignal.timeout(10_000),
            redirect: "manual",
          }),
      });
    } finally {
      await host.stop();
      await runtime.stop();
    }
  }

  test("refuses every request without the session token", async () => {
    await withHost(async ({ get }) => {
      for (const path of ["/", "/app.js", "/styles.css", "/api/dashboard"]) {
        const response = await get(path);
        expect(response.status).toBe(403);
      }
    });
  });

  test("exchanges the token for a cookie and then serves the console", async () => {
    await withHost(async ({ host, get }) => {
      const redirect = await get(`/?token=${host.token}`);
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("/");
      const cookie = redirect.headers.get("set-cookie")!;
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");

      const session = cookie.split(";")[0]!;
      const page = await get("/", { headers: { cookie: session } });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      const html = await page.text();
      expect(html).toContain("AI Office");
      expect(html).toContain("/app.js");
      expect(page.headers.get("content-security-policy")).toContain(
        "default-src 'none'",
      );

      const script = await get("/app.js", { headers: { cookie: session } });
      expect(script.status).toBe(200);
      expect(await script.text()).toBe(stubClientScript);
    });
  });

  test("proxies the query API to the daemon socket unchanged", async () => {
    await withHost(async ({ host, client, get }) => {
      const created = await client.execute(["project:create", "Proxied"]);
      const projectId = created.stdout[0]!.replace("Project created: ", "");
      const session = `ai_office_dashboard=${host.token}`;

      const response = await get("/api/dashboard", {
        headers: { cookie: session },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        queryApiVersion: number;
        dashboard: { projects: { projectId: string }[] };
      };
      expect(body.queryApiVersion).toBe(1);
      expect(body.dashboard.projects[0]?.projectId).toBe(projectId);

      // Daemon-side errors keep their status through the proxy.
      const missing = await get("/api/projects/nope", {
        headers: { cookie: session },
      });
      expect(missing.status).toBe(404);
    });
  });

  test("streams invalidation through to the browser", async () => {
    await withHost(async ({ host, client, get }) => {
      const controller = new AbortController();
      let seen = "";
      let pump: Promise<void> = Promise.resolve();
      try {
        const response = await get("/api/events", {
          headers: { cookie: `ai_office_dashboard=${host.token}` },
          signal: controller.signal,
        });
        expect(response.headers.get("content-type")).toBe("text/event-stream");

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        pump = (async () => {
          try {
            while (!seen.includes("event: invalidate")) {
              const chunk = await reader.read();
              if (chunk.done) break;
              seen += decoder.decode(chunk.value);
            }
          } catch {
            // Aborting the request is how this loop is expected to end.
          }
        })();

        // Named waits so a stall reports which step never happened instead of
        // surfacing as an opaque test timeout.
        const waitFor = async (fragment: string, label: string) => {
          for (let attempt = 0; attempt < 600; attempt += 1) {
            if (seen.includes(fragment)) return;
            await Bun.sleep(10);
          }
          throw new Error(
            `Timed out waiting for ${label}. Received so far: ${JSON.stringify(seen)}`,
          );
        };

        await waitFor("event: ready", "the proxied ready event");
        await client.execute(["project:create", "Streamed"]);
        await waitFor("event: invalidate", "the proxied invalidation event");

        expect(seen).toContain('"topic":"project.updated"');
      } finally {
        // Always release the stream: leaving it open would block the daemon's
        // graceful stop in the surrounding cleanup.
        controller.abort();
        await pump;
      }
    });
  }, 30_000);

  test("rejects an unexpected Host header even with a valid token", async () => {
    await withHost(async ({ host, get }) => {
      const response = await get("/api/dashboard", {
        headers: {
          host: "evil.example.com",
          cookie: `ai_office_dashboard=${host.token}`,
        },
      });
      expect(response.status).toBe(400);
    });
  });

  test("rejects writes", async () => {
    await withHost(async ({ host, get }) => {
      const response = await get("/api/dashboard", {
        method: "POST",
        headers: { cookie: `ai_office_dashboard=${host.token}` },
      });
      expect(response.status).toBe(405);
    });
  });

  test("reports the daemon as unavailable instead of failing opaquely", async () => {
    const projectRoot = mkdtempSync(
      join(tmpdir(), "ai-office-dashboard-gone-"),
    );
    temporaryDirectories.push(projectRoot);
    const host = await startDashboardHost({
      socketPath: join(projectRoot, "missing.sock"),
      port: 0,
      clientScript: stubClientScript,
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${host.port}/api/dashboard`,
        {
          headers: { cookie: `ai_office_dashboard=${host.token}` },
          signal: AbortSignal.timeout(5000),
        },
      );
      expect(response.status).toBe(503);
      expect((await response.json()) as Record<string, unknown>).toMatchObject({
        error: { code: "DAEMON_UNAVAILABLE" },
      });
    } finally {
      await host.stop();
    }
  });

  test("refuses to bind a non-loopback address", async () => {
    await expect(
      startDashboardHost({
        socketPath: "/tmp/does-not-matter.sock",
        hostname: "0.0.0.0",
        port: 0,
        clientScript: stubClientScript,
      }),
    ).rejects.toBeInstanceOf(DashboardHostError);
  });

  test("builds a real browser bundle from the dashboard sources", async () => {
    const projectRoot = mkdtempSync(
      join(tmpdir(), "ai-office-dashboard-bundle-"),
    );
    temporaryDirectories.push(projectRoot);
    const host = await startDashboardHost({
      socketPath: join(projectRoot, "missing.sock"),
      port: 0,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${host.port}/app.js`, {
        headers: { cookie: `ai_office_dashboard=${host.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status).toBe(200);
      const script = await response.text();
      expect(script.length).toBeGreaterThan(1000);
      // The bundle carries the rendering the unit tests cover.
      expect(script).toContain("Needs attention");
      expect(script).not.toContain("import ");
    } finally {
      await host.stop();
    }
  });
});
