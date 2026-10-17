import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
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

function accepts(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = createConnection(socketPath);
    connection.once("connect", () => {
      connection.destroy();
      resolve(true);
    });
    connection.once("error", () => resolve(false));
  });
}

// The path travels in the environment, never inside the script text.
const holderScripts = {
  /** An HTTP server answering 200. */
  answer:
    'Bun.serve({ unix: process.env.HOLDER_SOCKET_PATH, fetch: () => new Response("") }); setInterval(() => {}, 1000);',
  /** An HTTP server answering 404, as another service would. */
  foreign:
    'Bun.serve({ unix: process.env.HOLDER_SOCKET_PATH, fetch: () => Response.json({ foreign: true }, { status: 404 }) }); setInterval(() => {}, 1000);',
  /** Accepts connections and never answers. */
  silent:
    'require("node:net").createServer(() => {}).listen(process.env.HOLDER_SOCKET_PATH); setInterval(() => {}, 1000);',
} as const;

/**
 * Starts a process that listens on {@link socketPath} and resolves once it
 * accepts connections. Bun reports readiness from the child before the bind
 * is guaranteed, so the socket itself is probed. The caller kills the holder:
 * a SIGKILL leaves a stale socket file behind, as a crashed host would.
 */
export async function startSocketHolder(
  socketPath: string,
  behavior: keyof typeof holderScripts = "answer",
): Promise<ReturnType<typeof Bun.spawn>> {
  const holder = Bun.spawn(
    [process.execPath, "-e", holderScripts[behavior]],
    { stdout: "ignore", env: { ...process.env, HOLDER_SOCKET_PATH: socketPath } },
  );
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await accepts(socketPath)) return holder;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  holder.kill("SIGKILL");
  throw new Error(`Socket holder never listened on ${socketPath}`);
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
