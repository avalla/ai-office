/**
 * The dashboard's connection/refresh state machine.
 *
 * The invalidation stream has no replay, so reconnecting restores the
 * *connection*, never the *view*. These tests pin the invariant that makes the
 * `live` badge mean something:
 *
 * > Once the dashboard reports `live`, the current route has been re-queried
 * > after the most recent stream connection was established.
 *
 * The controller takes its refresh, route accessor, status sink, and timers as
 * inputs, so the whole machine is exercised here without a headless browser.
 */

import { describe, expect, test } from "vitest";
import {
  connectionLabel,
  connectionTone,
  createSyncController,
  type ConnectionState,
  type SyncController,
} from "../../apps/dashboard/src/ui/sync-controller.ts";
import type { DashboardRoute } from "../../apps/dashboard/src/ui/view-model.ts";

/** A controllable clock: timers fire only when a test says so. */
interface Harness {
  controller: SyncController;
  states: ConnectionState[];
  /** Routes passed to `refresh`, in order. */
  fetched: DashboardRoute[];
  /** Runs every scheduled callback whose turn has come. */
  flushTimers(): Promise<void>;
  /** Lets pending refresh promises settle. */
  settle(): Promise<void>;
  setRoute(route: DashboardRoute): void;
  failNext(times: number): void;
  /** Holds the next refresh open so a test can interleave events with it. */
  block(): () => void;
}

function harness(): Harness {
  const states: ConnectionState[] = [];
  const fetched: DashboardRoute[] = [];
  let route: DashboardRoute = { kind: "overview" };
  let failures = 0;
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = null;

  const timers = new Map<number, () => void>();
  let nextHandle = 1;

  const controller = createSyncController({
    refresh: async (target) => {
      fetched.push(target);
      if (gate !== null) {
        const pending = gate;
        gate = null;
        await pending;
      }
      if (failures > 0) {
        failures -= 1;
        throw new Error("query failed");
      }
    },
    currentRoute: () => route,
    onStateChange: (state) => states.push(state),
    schedule: (callback) => {
      const handle = nextHandle++;
      timers.set(handle, callback);
      return handle;
    },
    cancel: (handle) => {
      timers.delete(handle);
    },
    debounceMs: 250,
  });

  const settle = async (): Promise<void> => {
    // Several microtask turns: a refresh resolves, the loop may start another.
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };

  return {
    controller,
    states,
    fetched,
    async flushTimers() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, callback] of due) callback();
      await settle();
    },
    settle,
    setRoute(next) {
      route = next;
    },
    failNext(times) {
      failures = times;
    },
    block() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        release?.();
        release = null;
      };
    },
  };
}

describe("dashboard sync controller", () => {
  test("the initial load fetches the current route but is not yet live", async () => {
    const h = harness();

    h.controller.start();
    await h.settle();

    expect(h.fetched).toEqual([{ kind: "overview" }]);
    // No stream has been established, so nothing may claim to be live.
    expect(h.controller.state()).toBe("connecting");
  });

  test("the first connection triggers a synchronization before reporting live", async () => {
    const h = harness();
    h.controller.start();
    await h.settle();

    h.controller.streamEstablished();
    // Connected, but the route has not been queried under this connection yet.
    expect(h.controller.state()).toBe("syncing");
    expect(h.fetched).toHaveLength(1);

    await h.flushTimers();

    expect(h.fetched).toHaveLength(2);
    expect(h.controller.state()).toBe("live");
  });

  test("an invalidation triggers a synchronization", async () => {
    const h = harness();
    h.controller.start();
    await h.settle();
    h.controller.streamEstablished();
    await h.flushTimers();
    expect(h.controller.state()).toBe("live");

    h.controller.invalidated();
    await h.flushTimers();

    expect(h.fetched).toHaveLength(3);
    expect(h.controller.state()).toBe("live");
  });

  test("losing the stream marks the view reconnecting", async () => {
    const h = harness();
    h.controller.start();
    await h.settle();
    h.controller.streamEstablished();
    await h.flushTimers();

    h.controller.streamLost();

    expect(h.controller.state()).toBe("reconnecting");
  });

  test("a reconnect re-queries even when no invalidation arrived", async () => {
    const h = harness();
    h.controller.start();
    await h.settle();
    h.controller.streamEstablished();
    await h.flushTimers();
    expect(h.controller.state()).toBe("live");
    const beforeDrop = h.fetched.length;

    // The exact sequence the stream's invalidation-only contract permits:
    // the connection drops, state changes on the daemon, the invalidate event
    // is lost, and the connection comes back with nothing to replay.
    h.controller.streamLost();
    h.controller.streamEstablished();

    // Reconnected — but the badge must not say live until it has re-queried.
    expect(h.controller.state()).toBe("syncing");

    await h.flushTimers();

    expect(h.fetched.length).toBe(beforeDrop + 1);
    expect(h.controller.state()).toBe("live");
  });

  test("many ready and invalidate events do not start concurrent fetches", async () => {
    const h = harness();
    h.controller.start();
    await h.settle();

    for (let index = 0; index < 5; index += 1) {
      h.controller.streamEstablished();
      h.controller.invalidated();
    }
    await h.flushTimers();

    // The burst coalesces into one refetch on top of the initial load.
    expect(h.fetched).toHaveLength(2);
    expect(h.controller.state()).toBe("live");
  });

  test("a reconnect during an in-flight refresh still re-queries afterwards", async () => {
    const h = harness();
    const finish = h.block();
    h.controller.start();
    await h.settle();
    expect(h.fetched).toHaveLength(1);

    // The connection is established while the initial fetch is still open.
    h.controller.streamEstablished();
    await h.flushTimers();
    // The debounced refresh found the first one in flight and queued itself.
    expect(h.fetched).toHaveLength(1);

    finish();
    await h.settle();

    // The queued refresh ran, and only then does the badge go live.
    expect(h.fetched).toHaveLength(2);
    expect(h.controller.state()).toBe("live");
  });

  test("a route change invalidates live until the new route is queried", async () => {
    const h = harness();
    h.controller.start();
    await h.settle();
    h.controller.streamEstablished();
    await h.flushTimers();
    expect(h.controller.state()).toBe("live");

    const finish = h.block();
    h.setRoute({ kind: "project", projectId: "project-1" });
    h.controller.routeChanged();
    await h.settle();

    // The stream is still connected, but the *displayed* route has not been
    // queried yet, so `live` would be a lie about a different page.
    expect(h.controller.state()).toBe("syncing");

    finish();
    await h.settle();

    expect(h.fetched.at(-1)).toEqual({
      kind: "project",
      projectId: "project-1",
    });
    expect(h.controller.state()).toBe("live");
  });

  test("a route change while connected but unsynced does not become live early", async () => {
    const h = harness();
    h.controller.start();
    await h.settle();

    // Connection established; the debounced sync has not run yet.
    h.controller.streamEstablished();
    h.setRoute({ kind: "run", runId: "run-1" });
    h.controller.routeChanged();
    await h.settle();

    // The route change itself queried under the current connection, so this is
    // a genuine synchronization of the displayed route.
    expect(h.controller.state()).toBe("live");
    expect(h.fetched.at(-1)).toEqual({ kind: "run", runId: "run-1" });
  });

  test("a failed refresh never counts as a synchronization", async () => {
    const h = harness();
    h.controller.start();
    await h.settle();
    h.controller.streamEstablished();
    h.failNext(1);
    await h.flushTimers();

    // The query failed, so the displayed state is not the current state.
    expect(h.controller.state()).toBe("syncing");

    h.controller.invalidated();
    await h.flushTimers();

    expect(h.controller.state()).toBe("live");
  });

  test("state changes are reported once each, never repeated", async () => {
    const h = harness();
    h.controller.start();
    await h.settle();
    h.controller.streamEstablished();
    await h.flushTimers();
    h.controller.invalidated();
    await h.flushTimers();

    expect(h.states).toEqual(["syncing", "live"]);
  });

  test("labels and tones cover every state", () => {
    const states: ConnectionState[] = [
      "connecting",
      "syncing",
      "live",
      "reconnecting",
    ];
    for (const state of states) {
      expect(connectionLabel(state)).toBeTruthy();
      expect(connectionTone(state)).toBeTruthy();
    }
    expect(connectionTone("live")).toBe("good");
    expect(connectionTone("reconnecting")).toBe("attention");
    // Syncing is deliberately not the same tone as live.
    expect(connectionTone("syncing")).not.toBe(connectionTone("live"));
  });
});
