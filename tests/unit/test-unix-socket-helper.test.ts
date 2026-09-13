import { afterEach, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import {
  DARWIN_SUN_PATH_BYTES,
  TEST_SOCKET_PATH_BUDGET,
  createTestUnixSocket,
  resolveTestSocketBase,
} from "../helpers/unix-socket.ts";

/** A GitHub-hosted macOS runner's `$TMPDIR`, verbatim from the CI failure. */
const MACOS_RUNNER_TMPDIR = "/var/folders/36/tjdph2t965j8snz9_vkdnw0r0000gn/T";

/** The exact socket path that failed to bind with `ENAMETOOLONG` on macOS. */
const OBSERVED_FAILING_SOCKET_PATH = `${MACOS_RUNNER_TMPDIR}/ai-office-daemon-pipeline-TP3IEg/.ai-office/daemon.sock`;

const allocated: Array<{ cleanup: () => void }> = [];

function allocate() {
  const socket = createTestUnixSocket();
  allocated.push(socket);
  return socket;
}

function withTemporaryDirectory<T>(value: string, body: () => T): T {
  const previous = process.env["TMPDIR"];
  process.env["TMPDIR"] = value;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = previous;
  }
}

afterEach(() => {
  for (const socket of allocated.splice(0)) socket.cleanup();
});

describe("test Unix socket helper", () => {
  test("keeps allocated socket paths well inside the macOS sun_path limit", () => {
    const { socketPath } = allocate();
    const bytes = Buffer.byteLength(socketPath);
    expect(bytes).toBeLessThanOrEqual(TEST_SOCKET_PATH_BUDGET);
    // The budget is the contract; the platform limit is the reason for it.
    expect(TEST_SOCKET_PATH_BUDGET).toBeLessThan(DARWIN_SUN_PATH_BYTES - 32);
    expect(bytes).toBeLessThan(DARWIN_SUN_PATH_BYTES);
  });

  test("a long temporary directory does not lengthen the socket path", () => {
    // The original failure: a macOS runner's `/var/folders/...` `$TMPDIR` plus
    // a project directory name and `.ai-office/daemon.sock` filled `sun_path`
    // exactly, leaving no room for the terminating NUL.
    expect(
      Buffer.byteLength(OBSERVED_FAILING_SOCKET_PATH),
    ).toBeGreaterThanOrEqual(DARWIN_SUN_PATH_BYTES);
    const { socketPath } = withTemporaryDirectory(
      MACOS_RUNNER_TMPDIR,
      allocate,
    );
    expect(socketPath).not.toContain(MACOS_RUNNER_TMPDIR);
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(
      TEST_SOCKET_PATH_BUDGET,
    );
  });

  test("resolves a Darwin base independently of the ambient temporary directory", () => {
    expect(resolveTestSocketBase("darwin", MACOS_RUNNER_TMPDIR)).toBe("/tmp");
    expect(resolveTestSocketBase("linux", MACOS_RUNNER_TMPDIR)).toBe("/tmp");
    expect(resolveTestSocketBase("linux", "/tmp")).toBe("/tmp");
    // A short ambient temporary directory is already safe and is kept.
    expect(resolveTestSocketBase("darwin", "/t")).toBe("/t");
  });

  test("allocates absolute, unique roots that do not collide", () => {
    const first = allocate();
    const second = allocate();
    expect(first.socketPath.startsWith("/")).toBe(true);
    expect(first.root).not.toBe(second.root);
    expect(first.socketPath).not.toBe(second.socketPath);
    expect(dirname(first.socketPath)).toBe(first.root);
    expect(existsSync(first.root)).toBe(true);
    expect(existsSync(second.root)).toBe(true);
  });

  test("binds a real listener and removes the root on cleanup", async () => {
    const socket = createTestUnixSocket();
    const server = createServer();
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(socket.socketPath, done);
    });
    expect(existsSync(socket.socketPath)).toBe(true);
    await new Promise<void>((done) => server.close(() => done()));
    socket.cleanup();
    expect(existsSync(socket.root)).toBe(false);
  });
});
