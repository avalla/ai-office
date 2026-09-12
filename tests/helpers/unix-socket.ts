import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `sockaddr_un.sun_path` holds 104 bytes on macOS, including the terminating
 * NUL, against 108 on Linux. The limit applies to the literal path handed to
 * `bind(2)`, so a socket nested under a macOS `$TMPDIR` — a per-user
 * `/var/folders/<a>/<30 chars>/T` path roughly 48 bytes long — exhausts the
 * budget after one temporary directory name and a `.ai-office/daemon.sock`
 * suffix, and binding fails with `ENAMETOOLONG`.
 */
export const DARWIN_SUN_PATH_BYTES = 104;

/**
 * Upper bound this helper enforces on the paths it hands out. It is far below
 * {@link DARWIN_SUN_PATH_BYTES} on purpose: a future prefix or filename change
 * must fail loudly here rather than reintroduce a platform-specific bind
 * failure that only a macOS runner can observe.
 */
export const TEST_SOCKET_PATH_BUDGET = 64;

const SHORT_SOCKET_BASE = "/tmp";
const SOCKET_ROOT_PREFIX = "ao-s-";
const SOCKET_FILENAME = "d.sock";

/**
 * Chooses the shortest base directory a test socket can live in.
 *
 * POSIX guarantees `/tmp`, so wherever the ambient temporary directory is
 * longer than that — every macOS host, and any sandbox with a nested `$TMPDIR`
 * — sockets are allocated under `/tmp` instead. The rule is a pure function of
 * platform and temporary directory so the regression tests can assert Darwin
 * behaviour from a Linux host. It affects test harnesses only; production
 * `RuntimePaths` resolution is untouched.
 */
export function resolveTestSocketBase(
  platform: NodeJS.Platform = process.platform,
  temporaryDirectory: string = tmpdir(),
): string {
  if (platform === "win32") return temporaryDirectory;
  return SHORT_SOCKET_BASE.length < temporaryDirectory.length
    ? SHORT_SOCKET_BASE
    : temporaryDirectory;
}

export interface TestUnixSocket {
  /** Temporary directory holding nothing but this socket. */
  readonly root: string;
  /** Absolute, unique path a test Runtime host may bind. */
  readonly socketPath: string;
  /** Removes {@link root}. Call only once the listener has stopped. */
  cleanup(): void;
}

/**
 * Allocates a unique, short, absolute Unix socket path for a single test.
 *
 * The socket root is deliberately independent of the project or runtime
 * directory a test creates: project files, SQLite databases and generated views
 * have no path-length constraint, while the socket does. Tests keep using
 * `mkdtempSync(join(tmpdir(), ...))` for their own state and take only the
 * socket from here.
 */
export function createTestUnixSocket(): TestUnixSocket {
  const root = mkdtempSync(join(resolveTestSocketBase(), SOCKET_ROOT_PREFIX));
  const socketPath = join(root, SOCKET_FILENAME);
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > TEST_SOCKET_PATH_BUDGET) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(
      `Test Unix socket path is ${bytes} bytes, above the ${TEST_SOCKET_PATH_BUDGET}-byte budget: ${socketPath}`,
    );
  }
  return {
    root,
    socketPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
