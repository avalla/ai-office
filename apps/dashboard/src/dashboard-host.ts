/**
 * Loopback host for the read-only dashboard.
 *
 * The daemon keeps its owner-only Unix socket and does not open a TCP port.
 * A browser cannot speak to a Unix socket, so this process is the bridge: it
 * serves the static bundle and forwards `/api/*` to the daemon socket
 * unchanged. It holds no state, performs no queries, and answers nothing the
 * daemon would not answer.
 *
 * That keeps the dependency direction intact —
 * `dashboard -> daemon query API -> application query services` — and keeps TCP
 * exposure explicit, user-initiated, and no longer lived than the command.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { queryApiPrefix } from "@ai-office/application/protocol/query-protocol.ts";
import {
  decideAccess,
  sessionCookieValue,
  sessionTokenParameter,
  type AccessPolicy,
} from "./dashboard-session.ts";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

export interface DashboardHostOptions {
  /** Absolute path of the daemon's Unix socket. */
  socketPath: string;
  /** Loopback address to bind. Anything else is refused. */
  hostname?: string;
  /** `0` asks the operating system for a free port. */
  port?: number;
  token?: string;
  assetDirectory?: string;
  /** Overrides bundling, so tests need not run a bundler. */
  clientScript?: string;
}

export interface RunningDashboardHost {
  url: string;
  port: number;
  hostname: string;
  token: string;
  stop(): Promise<void>;
}

export class DashboardHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardHostError";
  }
}

const loopbackHostnames = new Set(["127.0.0.1", "::1", "localhost"]);

function json(
  value: unknown,
  status: number,
  headers?: Record<string, string>,
): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

function text(
  body: string,
  status: number,
  contentType: string,
  headers?: Record<string, string>,
): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
      // The page loads only its own inline-free bundle and talks only to its
      // own origin, so the policy can be strict without special cases.
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

/**
 * Builds the browser bundle from the TypeScript sources.
 *
 * Bun is already the runtime, so bundling in memory at start avoids adding a
 * build step, a bundler dependency, or a checked-in artifact that can drift
 * from the read models it renders.
 */
async function buildClientScript(): Promise<string> {
  const entry = join(sourceDirectory, "ui", "entry.ts");
  const built = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    minify: false,
  });
  if (!built.success)
    throw new DashboardHostError(
      `The dashboard bundle failed to build: ${built.logs.map(String).join("; ")}`,
    );
  const output = built.outputs[0];
  if (output === undefined)
    throw new DashboardHostError("The dashboard bundle produced no output");
  return output.text();
}

export async function startDashboardHost(
  options: DashboardHostOptions,
): Promise<RunningDashboardHost> {
  const hostname = options.hostname ?? "127.0.0.1";
  if (!loopbackHostnames.has(hostname))
    throw new DashboardHostError(
      `The dashboard only binds loopback addresses; refusing ${hostname}`,
    );

  const token = options.token ?? crypto.randomUUID().replaceAll("-", "");
  const assetDirectory =
    options.assetDirectory ?? join(sourceDirectory, "assets");
  const [indexHtml, styles, clientScript] = await Promise.all([
    Bun.file(join(assetDirectory, "index.html")).text(),
    Bun.file(join(assetDirectory, "styles.css")).text(),
    options.clientScript === undefined
      ? buildClientScript()
      : Promise.resolve(options.clientScript),
  ]);

  const server = Bun.serve({
    hostname,
    port: options.port ?? 0,
    idleTimeout: 0,
    fetch: (request) => handle(request),
  });

  const boundPort = server.port;
  if (boundPort === undefined) {
    await server.stop(true);
    throw new DashboardHostError("The dashboard host did not bind a port");
  }
  const authority = `${hostname === "::1" ? "[::1]" : hostname}:${boundPort}`;
  const policy: AccessPolicy = {
    token,
    allowedHosts: new Set([authority, `localhost:${boundPort}`]),
  };

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const decision = decideAccess(
      {
        method: request.method,
        pathname: url.pathname,
        hostHeader: request.headers.get("host"),
        cookieHeader: request.headers.get("cookie"),
        queryToken: url.searchParams.get(sessionTokenParameter),
      },
      policy,
    );

    if (decision.kind === "deny")
      return json(
        { error: { code: "FORBIDDEN", message: decision.message } },
        decision.status,
      );

    // The token arrives once in the URL the CLI prints; it is exchanged for a
    // cookie and redirected away so it never lingers in history or a referrer.
    const cookieHeaders =
      decision.kind === "adopt_token"
        ? { "set-cookie": sessionCookieValue(token) }
        : undefined;
    if (
      decision.kind === "adopt_token" &&
      url.searchParams.has(sessionTokenParameter)
    )
      return new Response(null, {
        status: 302,
        headers: {
          location: `${url.pathname}${url.hash}`,
          "cache-control": "no-store",
          ...cookieHeaders,
        },
      });

    if (url.pathname === "/app.js")
      return text(
        clientScript,
        200,
        "text/javascript; charset=utf-8",
        cookieHeaders,
      );
    if (url.pathname === "/styles.css")
      return text(styles, 200, "text/css; charset=utf-8", cookieHeaders);

    if (url.pathname.startsWith(`${queryApiPrefix}/`))
      return proxy(request, url, cookieHeaders);

    if (url.pathname === "/" || url.pathname === "/index.html")
      return text(indexHtml, 200, "text/html; charset=utf-8", cookieHeaders);

    return json(
      { error: { code: "NOT_FOUND", message: "Unknown dashboard route" } },
      404,
    );
  }

  async function proxy(
    request: Request,
    url: URL,
    cookieHeaders: Record<string, string> | undefined,
  ): Promise<Response> {
    let upstream: Response;
    try {
      upstream = await fetch(`http://localhost${url.pathname}${url.search}`, {
        method: "GET",
        unix: options.socketPath,
        headers: { accept: request.headers.get("accept") ?? "*/*" },
      });
    } catch {
      return json(
        {
          error: {
            code: "DAEMON_UNAVAILABLE",
            message: "The AI Office daemon is not reachable",
          },
        },
        503,
        cookieHeaders,
      );
    }

    // Only headers the browser needs are copied through; nothing from the
    // daemon response is reinterpreted here.
    const headers = new Headers({
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
      ...cookieHeaders,
    });
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  return {
    url: `http://${authority}/`,
    port: boundPort,
    hostname,
    token,
    stop: async () => {
      await server.stop(true);
    },
  };
}
