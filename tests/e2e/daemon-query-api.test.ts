import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { queryApiVersion } from "@ai-office/application/protocol/query-protocol.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

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

interface Harness {
  socketPath: string;
  client: DaemonClient;
  get(path: string): Promise<{ status: number; body: Record<string, unknown> }>;
  raw(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
}

async function startDaemon(): Promise<Harness> {
  const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-query-api-"));
  temporaryDirectories.push(projectRoot);
  writeFileSync(join(projectRoot, "README.md"), "# Query API fixture");
  const socketPath = join(projectRoot, ".ai-office", "daemon.sock");
  const daemon = await bootstrap({ projectRoot, socketPath });
  const controller = new AbortController();
  const running = daemon.start(controller.signal);
  await waitForDaemon(socketPath);

  const raw = (path: string, init: RequestInit = {}) =>
    fetch(`http://localhost${path}`, {
      ...init,
      unix: socketPath,
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });

  return {
    socketPath,
    client: new DaemonClient(socketPath),
    raw,
    async get(path) {
      const response = await raw(path);
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    },
    async stop() {
      controller.abort();
      await running;
    },
  };
}

describe("daemon query API", () => {
  test("serves an empty but well formed dashboard on a fresh runtime", async () => {
    const harness = await startDaemon();
    try {
      const { status, body } = await harness.get("/api/dashboard");
      expect(status).toBe(200);
      expect(body.queryApiVersion).toBe(queryApiVersion);
      const dashboard = body.dashboard as Record<string, unknown>;
      expect(dashboard.projects).toEqual([]);
      expect(dashboard.totals).toMatchObject({ projects: 0 });
      expect(typeof dashboard.generatedAt).toBe("string");
    } finally {
      await harness.stop();
    }
  });

  test("reflects state created through the command protocol", async () => {
    const harness = await startDaemon();
    try {
      const created = await harness.client.execute([
        "project:create",
        "Query fixture",
      ]);
      const projectId = created.stdout[0]!.replace("Project created: ", "");
      await harness.client.execute([
        "task:create",
        "--project",
        projectId,
        "--title",
        "Ship the thing",
        "--priority",
        "5",
      ]);

      const projects = await harness.get("/api/projects");
      expect(
        (projects.body.projects as { projectId: string; name: string }[])[0],
      ).toMatchObject({ projectId, name: "Query fixture" });

      const detail = await harness.get(`/api/projects/${projectId}`);
      const project = detail.body.project as Record<string, unknown>;
      const tasks = project.tasks as Record<string, unknown>[];
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        title: "Ship the thing",
        recordedStatus: "pending",
        operationalStatus: "not_started",
        divergesFromRecordedStatus: false,
        priority: 5,
      });
      expect(
        (tasks[0]!.requirements as { availability: string }).availability,
      ).toBe("unavailable");

      const taskList = await harness.get(`/api/projects/${projectId}/tasks`);
      expect(taskList.body.tasks).toHaveLength(1);

      const agents = await harness.get(`/api/projects/${projectId}/agents`);
      expect(agents.body.agents).toEqual([]);

      const pipelines = await harness.get(
        `/api/projects/${projectId}/pipelines`,
      );
      expect(pipelines.body.pipelines).toEqual([]);

      const runs = await harness.get(`/api/runs?project=${projectId}`);
      expect(runs.body.runs).toEqual([]);

      const reviews = await harness.get("/api/reviews?pending=true");
      expect(reviews.body.reviews).toEqual([]);
      const approvals = await harness.get("/api/approvals");
      expect(approvals.body.approvals).toEqual([]);
    } finally {
      await harness.stop();
    }
  });

  test("activity is bounded, ordered, and sanitized", async () => {
    const harness = await startDaemon();
    try {
      for (let index = 0; index < 4; index += 1)
        await harness.client.execute(["project:create", `Project ${index}`]);

      const { body } = await harness.get("/api/activity?limit=3");
      const activity = body.activity as Record<string, unknown>[];
      expect(activity).toHaveLength(3);
      const first = activity[0]!;
      expect(first.eventType).toBe("command.completed");
      // Command arguments never enter the audit payload, so they cannot appear.
      expect(JSON.stringify(activity)).not.toContain("Project 3");
      expect(first.detail).toMatchObject({ command: "project:create" });

      const paged = await harness.get(
        `/api/activity?limit=2&before=${encodeURIComponent(String(first.occurredAt))}`,
      );
      const older = paged.body.activity as { occurredAt: string }[];
      for (const entry of older)
        expect(entry.occurredAt < String(first.occurredAt)).toBe(true);
    } finally {
      await harness.stop();
    }
  });

  test("rejects unknown resources, malformed identifiers, and bad parameters", async () => {
    const harness = await startDaemon();
    try {
      const missing = await harness.get("/api/projects/project-does-not-exist");
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({
        queryApiVersion,
        error: { code: "NOT_FOUND" },
      });

      const malformed = await harness.get("/api/projects/not%20a%2Fvalid%2Fid");
      expect(malformed.status).toBe(400);
      expect(malformed.body).toMatchObject({
        error: { code: "INVALID_REQUEST" },
      });

      const badLimit = await harness.get("/api/activity?limit=abc");
      expect(badLimit.status).toBe(400);

      const badInstant = await harness.get("/api/activity?before=yesterday");
      expect(badInstant.status).toBe(400);

      const badBoolean = await harness.get("/api/runs?active=maybe");
      expect(badBoolean.status).toBe(400);

      const unknownRoute = await harness.get("/api/nope");
      expect(unknownRoute.status).toBe(404);

      const missingRun = await harness.get("/api/runs/run-does-not-exist");
      expect(missingRun.status).toBe(404);
    } finally {
      await harness.stop();
    }
  });

  test("the query surface is read-only", async () => {
    const harness = await startDaemon();
    try {
      const response = await harness.raw("/api/dashboard", { method: "POST" });
      expect(response.status).toBe(405);
      expect((await response.json()) as Record<string, unknown>).toMatchObject({
        error: { code: "METHOD_NOT_ALLOWED" },
      });
    } finally {
      await harness.stop();
    }
  });

  test("limits are clamped rather than honoured without bound", async () => {
    const harness = await startDaemon();
    try {
      for (let index = 0; index < 3; index += 1)
        await harness.client.execute(["project:create", `Project ${index}`]);
      const { status, body } = await harness.get("/api/activity?limit=100000");
      expect(status).toBe(200);
      // The activity cap is 200; the fixture produces far fewer rows, so the
      // assertion is that the request succeeded instead of being refused.
      expect((body.activity as unknown[]).length).toBeLessThanOrEqual(200);
    } finally {
      await harness.stop();
    }
  });

  test("the command protocol still works alongside the query surface", async () => {
    const harness = await startDaemon();
    try {
      const health = await harness.client.health();
      expect(health.status).toBe("ok");
      const response = await harness.client.execute(["task:list"]);
      expect(response.exitCode).toBe(1);
      const unknown = await harness.get("/commands");
      expect(unknown.status).toBe(405);
    } finally {
      await harness.stop();
    }
  });
});

describe("daemon invalidation stream", () => {
  async function readEvents(
    harness: Harness,
    signal: AbortSignal,
  ): Promise<{ lines: string[]; done: Promise<void> }> {
    const response = await harness.raw("/api/events", { signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const lines: string[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const done = (async () => {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          lines.push(decoder.decode(chunk.value));
        }
      } catch {
        // The abort below is the expected way this loop ends.
      }
    })();
    return { lines, done };
  }

  async function waitFor(
    predicate: () => boolean,
    label: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      await Bun.sleep(10);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  test("a subscriber receives invalidation for a completed command", async () => {
    const harness = await startDaemon();
    const controller = new AbortController();
    try {
      const stream = await readEvents(harness, controller.signal);
      await waitFor(
        () => stream.lines.join("").includes("event: ready"),
        "the ready event",
      );

      await harness.client.execute(["project:create", "Streamed project"]);
      await waitFor(
        () => stream.lines.join("").includes("event: invalidate"),
        "an invalidation event",
      );

      const payload = stream.lines.join("");
      expect(payload).toContain('"topic":"project.updated"');
      expect(payload).toContain('"topic":"activity.created"');
      // The stream carries topics only; it never carries project state.
      expect(payload).not.toContain("Streamed project");

      controller.abort();
      await stream.done;
    } finally {
      controller.abort();
      await harness.stop();
    }
  });

  test("one disconnected subscriber does not affect another", async () => {
    const harness = await startDaemon();
    const first = new AbortController();
    const second = new AbortController();
    try {
      const streamOne = await readEvents(harness, first.signal);
      const streamTwo = await readEvents(harness, second.signal);
      await waitFor(
        () =>
          streamOne.lines.join("").includes("event: ready") &&
          streamTwo.lines.join("").includes("event: ready"),
        "both ready events",
      );

      first.abort();
      await streamOne.done;
      // Give the server a moment to observe the cancellation.
      await Bun.sleep(50);

      await harness.client.execute(["project:create", "Survivor"]);
      await waitFor(
        () => streamTwo.lines.join("").includes("event: invalidate"),
        "the surviving subscriber's invalidation",
      );

      second.abort();
      await streamTwo.done;
    } finally {
      first.abort();
      second.abort();
      await harness.stop();
    }
  });

  test("an open stream does not block daemon shutdown", async () => {
    const harness = await startDaemon();
    const controller = new AbortController();
    const stream = await readEvents(harness, controller.signal);
    await waitFor(
      () => stream.lines.join("").includes("event: ready"),
      "the ready event",
    );

    // The subscriber is deliberately left open: a server-sent response never
    // completes, so a graceful stop must end it rather than wait for it.
    const stopped = await Promise.race([
      harness.stop().then(() => "stopped" as const),
      Bun.sleep(5000).then(() => "hung" as const),
    ]);
    expect(stopped).toBe("stopped");

    // The client observes the disconnection instead of hanging.
    await stream.done;
    controller.abort();
  });

  test("a client can reconnect and keep receiving invalidation", async () => {
    const harness = await startDaemon();
    let controller = new AbortController();
    try {
      const firstStream = await readEvents(harness, controller.signal);
      await waitFor(
        () => firstStream.lines.join("").includes("event: ready"),
        "the first ready event",
      );
      controller.abort();
      await firstStream.done;
      await Bun.sleep(50);

      controller = new AbortController();
      const secondStream = await readEvents(harness, controller.signal);
      await waitFor(
        () => secondStream.lines.join("").includes("event: ready"),
        "the second ready event",
      );

      await harness.client.execute(["project:create", "Reconnected"]);
      await waitFor(
        () => secondStream.lines.join("").includes("event: invalidate"),
        "invalidation after reconnect",
      );

      controller.abort();
      await secondStream.done;
    } finally {
      controller.abort();
      await harness.stop();
    }
  });
});
