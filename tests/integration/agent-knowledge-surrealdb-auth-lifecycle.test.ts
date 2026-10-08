import { expect, it } from "vitest";
import { CborCodec } from "../../packages/storage-surrealdb/node_modules/surrealdb";
import { connectSurrealAgentKnowledgeStore } from "../../packages/storage-surrealdb/src/connect-agent-knowledge-store.ts";

/**
 * Proves the SDK 2.0.8 authentication lifecycle of
 * `connectSurrealAgentKnowledgeStore` against a fake SurrealDB server that
 * speaks the real CBOR wire protocol over a real WebSocket. The SDK itself
 * drives sign-in, token renewal, and reconnection; the server only answers.
 *
 * Server behaviour emulates a SurrealDB that always rejects `authenticate`
 * (expired/stale token) and never issues refresh tokens, so the SDK's only
 * recovery path is replaying the connect-time `authentication` provider. That
 * is exactly the session-loss fix under test: a manual `db.signin()` in the
 * connect function would set the SDK's `authOverriden` flag and disable the
 * replay, which test 1 detects as a second sign-in at connect time.
 */

interface WireRequest {
  id: string;
  method: string;
  params?: unknown[];
}

interface RecordedRequest {
  method: string;
  params: unknown[];
}

interface FakeConnection {
  requests: RecordedRequest[];
  /** Access tokens issued by successful sign-ins on this connection. */
  issuedTokens: string[];
  /** Server-side socket close; triggers the SDK's automatic reconnect. */
  drop: () => void;
  /** Resolves once the server observed the socket close. */
  closeObserved: Promise<void>;
}

interface FakeSurreal {
  endpoint: string;
  connections: FakeConnection[];
  stop: () => void;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** The SDK only payload-parses tokens (fastParseJwt), so any signature works. */
function issueToken(serial: number, ttlSec: number): string {
  const payload = { exp: Math.floor(Date.now() / 1000) + ttlSec, serial };
  return `${base64url(JSON.stringify({ alg: "none" }))}.${base64url(JSON.stringify(payload))}.signature`;
}

function tokenSerial(token: string): number {
  const [, payload] = token.split(".");
  if (!payload) throw new Error(`malformed test token: ${token}`);
  return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { serial: number }).serial;
}

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function withDeadline(promise: Promise<void>, timeoutMs: number, label: string): Promise<void> {
  return Promise.race([
    promise,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)), timeoutMs),
    ),
  ]);
}

function startFakeSurreal(options: {
  accessTokenTtlSec: number;
  rejectPassword?: string;
  /** Leave the version handshake unanswered so connect() stays pending. */
  neverAnswerVersion?: boolean;
}): FakeSurreal {
  const codec = new CborCodec({});
  const connections: FakeConnection[] = [];
  let serial = 0;
  const server = Bun.serve<{ connection: FakeConnection; notifyClosed: () => void }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, s) {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected a websocket upgrade", { status: 400 });
      }
      let notifyClosed!: () => void;
      const closeObserved = new Promise<void>((resolve) => {
        notifyClosed = resolve;
      });
      const connection: FakeConnection = {
        requests: [],
        issuedTokens: [],
        // Bound to the live socket in `open` below.
        drop: () => {},
        closeObserved,
      };
      const data = { connection, notifyClosed };
      // The negotiated subprotocol is deliberately NOT echoed via upgrade()
      // headers: Bun <= 1.3.6 answers such upgrades with a response its own
      // WebSocket client rejects (close 1002 "Mismatch client protocol"),
      // while the SDK never inspects the negotiated protocol — it only needs
      // the binary CBOR frames, which flow regardless.
      if (!s.upgrade(request, { data })) {
        return new Response("upgrade refused", { status: 400 });
      }
      connections.push(connection);
      return undefined as unknown as Response;
    },
    websocket: {
      open(ws) {
        ws.data.connection.drop = () => ws.close();
      },
      message(ws, data) {
        const request = codec.decode<WireRequest>(data as Uint8Array);
        const { connection } = ws.data;
        connection.requests.push({ method: request.method, params: request.params ?? [] });
        const respond = (result: unknown) => {
          ws.send(codec.encode({ id: request.id, result }));
        };
        const fail = (code: number, message: string) => {
          ws.send(codec.encode({ id: request.id, error: { code, message } }));
        };
        switch (request.method) {
          case "version":
            // The SDK requires >= 2.1.0 and < 4.0.0 and calls this first.
            if (options.neverAnswerVersion) return;
            return respond("surrealdb-2.2.0");
          case "use":
            return respond(null);
          case "signin": {
            const credentials = (request.params ?? [])[0] as { user?: string; pass?: string };
            if (options.rejectPassword !== undefined && credentials?.pass === options.rejectPassword) {
              return fail(-100, "invalid credentials");
            }
            const access = issueToken(++serial, options.accessTokenTtlSec);
            connection.issuedTokens.push(access);
            // Only `access` is returned: without a refresh token the SDK skips
            // its refresh attempt and falls through to the provider replay.
            return respond({ access });
          }
          case "authenticate":
            // Always reject: emulates SurrealDB refusing an expired or stale
            // token, forcing the SDK off the authenticate/refresh paths.
            return fail(-100, "token expired");
          case "query":
            // Every store statement (namespace/database DDL, schema DDL,
            // scoped reads) resolves generically; the adapter only inspects
            // the array-of-responses shape, which this preserves.
            return respond([{ status: "OK", time: "1ms", result: [] }]);
          case "ping":
            return respond(null);
          default:
            return fail(-1, `unexpected method ${request.method}`);
        }
      },
      close(ws) {
        ws.data.notifyClosed();
      },
    },
  });
  return {
    endpoint: `ws://127.0.0.1:${server.port}/rpc`,
    connections,
    stop: () => server.stop(),
  };
}

function signinsOn(connection: FakeConnection): RecordedRequest[] {
  return connection.requests.filter((request) => request.method === "signin");
}

function connectConfig(endpoint: string, password = "root-password") {
  return {
    endpoint,
    namespace: "auth_lifecycle_ns",
    database: "auth_lifecycle_db",
    username: "auth-user",
    password,
  };
}

it("authenticates via the connect-time provider exactly once before connect resolves", async () => {
  const fake = startFakeSurreal({ accessTokenTtlSec: 3600 });
  try {
    const { close } = await connectSurrealAgentKnowledgeStore(connectConfig(fake.endpoint));
    try {
      expect(fake.connections).toHaveLength(1);
      const connection = fake.connections[0]!;
      // The regression guard: a manual db.signin() in the connect function
      // would show up as a second sign-in on this connection.
      expect(signinsOn(connection)).toHaveLength(1);
      expect(signinsOn(connection)[0]!.params).toEqual([{ user: "auth-user", pass: "root-password" }]);
      // Handshake order on the wire: version check, scope, then sign-in —
      // so every DDL query below already ran authenticated.
      const methods = connection.requests.map((request) => request.method);
      const signinIndex = methods.indexOf("signin");
      expect(methods.slice(0, signinIndex)).toEqual(["version", "use"]);
      expect(methods.indexOf("query")).toBeGreaterThan(signinIndex);
      // No authenticate call and no provider replay fired at connect time.
      expect(connection.requests.filter((request) => request.method === "authenticate")).toHaveLength(0);
      expect(connection.issuedTokens).toHaveLength(1);
    } finally {
      await close();
    }
    await withDeadline(fake.connections[0]!.closeObserved, 5_000, "server-side socket close after store.close()");
  } finally {
    fake.stop();
  }
});

it("re-authenticates with the stored credentials when the token expires", async () => {
  const fake = startFakeSurreal({ accessTokenTtlSec: 2 });
  try {
    const { close } = await connectSurrealAgentKnowledgeStore(connectConfig(fake.endpoint));
    try {
      const connection = fake.connections[0]!;
      expect(connection.issuedTokens).toHaveLength(1);
      // The SDK schedules renewal at the token's ~2s expiry (#handleAuthChanged);
      // with the token already expired and no refresh token issued, #applyAuthentication
      // replays the connect-time provider directly — a fresh sign-in with the
      // same credentials on the same connection.
      await waitFor(
        () => signinsOn(connection).length >= 2,
        15_000,
        "second sign-in after token expiry",
      );
      expect(fake.connections).toHaveLength(1);
      const signins = signinsOn(connection);
      expect(signins[1]!.params).toEqual([{ user: "auth-user", pass: "root-password" }]);
      expect(connection.issuedTokens.length).toBeGreaterThanOrEqual(2);
      expect(tokenSerial(connection.issuedTokens[1]!)).toBeGreaterThan(tokenSerial(connection.issuedTokens[0]!));
    } finally {
      await close();
    }
  } finally {
    fake.stop();
  }
});

it("replays authentication after an automatic reconnect", async () => {
  const fake = startFakeSurreal({ accessTokenTtlSec: 3600 });
  try {
    const { store, close } = await connectSurrealAgentKnowledgeStore(connectConfig(fake.endpoint));
    try {
      const first = fake.connections[0]!;
      expect(signinsOn(first)).toHaveLength(1);
      first.drop();
      // Default reconnect backoff: 1000ms * 2^1 +/- 10% jitter.
      await waitFor(() => fake.connections.length >= 2, 20_000, "second websocket connection");
      const second = fake.connections[1]!;
      await waitFor(() => signinsOn(second).length >= 1, 5_000, "provider replay on reconnect");
      // authOverriden stayed false: with the cached token still valid the
      // handshake first tries authenticate() (rejected by the server), then
      // replays the connect-time provider exactly once.
      const methods = second.requests.map((request) => request.method);
      const signinIndex = methods.indexOf("signin");
      expect(methods.slice(0, signinIndex)).toEqual(["version", "use", "authenticate"]);
      expect(signinsOn(second)).toHaveLength(1);
      expect(signinsOn(second)[0]!.params).toEqual([{ user: "auth-user", pass: "root-password" }]);
      // A store read on the new connection resolves (absent knowledge -> null).
      expect(await store.traceMemoryProvenance({ tenantId: "tenant-t", repositoryId: "repo-r" }, "missing-memory")).toBeNull();
      expect(second.requests.some((request) => request.method === "query")).toBe(true);
    } finally {
      await close();
    }
  } finally {
    fake.stop();
  }
});

it("rejects and cleans up when credentials are invalid", async () => {
  const fake = startFakeSurreal({ accessTokenTtlSec: 3600, rejectPassword: "wrong-password" });
  try {
    await expect(
      connectSurrealAgentKnowledgeStore(connectConfig(fake.endpoint, "wrong-password")),
    ).rejects.toThrow();
    expect(fake.connections).toHaveLength(1);
    expect(fake.connections[0]!.issuedTokens).toHaveLength(0);
    // The failed connect must close its socket server-side, not leak it.
    await withDeadline(fake.connections[0]!.closeObserved, 5_000, "server-side socket close after rejected connect");
  } finally {
    fake.stop();
  }
});

it("rejects with the cancellation error when aborted mid-connect", async () => {
  const fake = startFakeSurreal({ accessTokenTtlSec: 3600, neverAnswerVersion: true });
  try {
    const controller = new AbortController();
    const connecting = connectSurrealAgentKnowledgeStore(connectConfig(fake.endpoint), controller.signal);
    await waitFor(() => fake.connections.length === 1, 5_000, "first websocket connection");
    controller.abort();
    await expect(connecting).rejects.toThrow("Agent knowledge connection cancelled");
    // The aborted connect must still close its socket server-side.
    await withDeadline(fake.connections[0]!.closeObserved, 5_000, "server-side socket close after aborted connect");
  } finally {
    fake.stop();
  }
});
