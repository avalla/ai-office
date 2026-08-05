import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import {
  daemonProtocolLimits,
  daemonProtocolVersion,
  type DaemonCommandRequest,
  type DaemonCommandResponse,
} from "@ai-office/application/protocol/daemon-protocol.ts";
import type { DaemonCommandHandler } from "../../apps/daemon/src/local-command-handler.ts";
import { OfficeDaemon } from "../../apps/daemon/src/office-daemon.ts";

const roots: string[] = [];
const events = {
  execute: async () => undefined,
} as unknown as RecordAuditEvent;

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function waitForHealth(socketPath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch("http://localhost/health", {
        unix: socketPath,
      });
      if (response.ok) return;
    } catch {
      await Bun.sleep(5);
    }
  }
  throw new Error("Daemon did not become healthy");
}

const request = (requestId: string, args: string[]): DaemonCommandRequest => ({
  protocolVersion: daemonProtocolVersion,
  requestId,
  args,
});

const post = (socketPath: string, body: string) =>
  fetch("http://localhost/commands", {
    unix: socketPath,
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

describe("daemon hardening", () => {
  test("does not hold the global queue during run:tick and returns typed errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-daemon-hardening-"));
    roots.push(root);
    const socketPath = join(root, "daemon.sock");
    let releaseTick!: () => void;
    const tickGate = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
    const handler: DaemonCommandHandler = {
      execute: async (value): Promise<DaemonCommandResponse> => {
        if (value.args[0] === "run:tick") await tickGate;
        if (value.args[0] === "boom") throw new Error("secret stack detail");
        return {
          protocolVersion: daemonProtocolVersion,
          requestId: value.requestId,
          exitCode: 0,
          stdout: [value.args[0] ?? "help"],
          stderr: [],
        };
      },
    };
    const daemon = new OfficeDaemon({
      socketPath,
      handler,
      events,
      commandTimeoutMs: 1_000,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    try {
      await waitForHealth(socketPath);
      const tick = post(
        socketPath,
        JSON.stringify(request("tick", ["run:tick"])),
      );
      await Bun.sleep(10);
      const short = await post(
        socketPath,
        JSON.stringify(request("short", ["project:profile"])),
      );
      expect(short.status).toBe(200);
      expect((await short.json()) as unknown).toMatchObject({
        requestId: "short",
        stdout: ["project:profile"],
      });
      releaseTick();
      expect((await tick).status).toBe(200);

      const invalid = await post(socketPath, "not-json");
      expect(invalid.status).toBe(400);
      expect((await invalid.json()) as unknown).toMatchObject({
        error: { code: "INVALID_REQUEST" },
      });

      const oversized = await post(
        socketPath,
        "x".repeat(daemonProtocolLimits.maxPayloadBytes + 1),
      );
      expect(oversized.status).toBe(413);
      expect((await oversized.json()) as unknown).toMatchObject({
        error: { code: "PAYLOAD_TOO_LARGE" },
      });

      const unexpected = await post(
        socketPath,
        JSON.stringify(request("boom", ["boom"])),
      );
      expect(unexpected.status).toBe(500);
      const error = (await unexpected.json()) as {
        error: { code: string; message: string };
      };
      expect(error.error).toEqual({
        code: "INTERNAL_ERROR",
        message: "Command execution failed",
      });
      expect(JSON.stringify(error)).not.toContain("secret stack detail");
    } finally {
      controller.abort();
      await running;
    }
  });

  test("returns a typed command timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-daemon-timeout-"));
    roots.push(root);
    const socketPath = join(root, "daemon.sock");
    const handler: DaemonCommandHandler = {
      execute: async () => new Promise<never>(() => undefined),
    };
    const daemon = new OfficeDaemon({
      socketPath,
      handler,
      events,
      commandTimeoutMs: 10,
    });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    try {
      await waitForHealth(socketPath);
      const response = await post(
        socketPath,
        JSON.stringify(request("timeout", ["project:profile"])),
      );
      expect(response.status).toBe(504);
      expect((await response.json()) as unknown).toMatchObject({
        requestId: "timeout",
        error: { code: "COMMAND_TIMEOUT" },
      });
    } finally {
      controller.abort();
      await running;
    }
  });
});
