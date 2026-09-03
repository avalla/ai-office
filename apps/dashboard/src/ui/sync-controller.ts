/**
 * Connection and refresh state machine for the dashboard shell.
 *
 * The invalidation stream carries topics, never state, and it has no replay. A
 * client that misses an event is stale until it re-queries — so restoring the
 * *connection* is not the same as restoring the *view*. Reporting `live` merely
 * because an `EventSource` opened would let this happen:
 *
 * ```text
 * state A loaded -> stream drops -> a command changes A to B ->
 * the invalidate event is missed -> stream reconnects ->
 * the page says "live" and still shows A
 * ```
 *
 * The invariant this module enforces instead:
 *
 * > Once the dashboard reports `live`, the current route has been re-queried
 * > after the most recent stream connection was established.
 *
 * It is expressed as a *sync token* — the connection epoch paired with the
 * route key. Every connection bumps the epoch and every navigation changes the
 * route key, so either one invalidates the token. A refresh captures the token
 * it started under and adopts it only when it *succeeds*; the state is `live`
 * only while the adopted token still equals the current one.
 *
 * Everything impure is injected: the refresh itself, the route accessor, the
 * status sink, and the timers. That keeps the machine unit-testable without a
 * headless browser, which is the only untested part of the shell otherwise.
 */

import { routeHref, type DashboardRoute } from "./view-model.ts";

/**
 * What the connection badge reports.
 *
 * - `connecting` — no stream has ever been established.
 * - `syncing` — a stream is up but the current route has not been re-queried
 *   under it yet. Deliberately *not* `live`: the connection is healthy and the
 *   displayed state may still be stale.
 * - `live` — connected, and the displayed route was queried under this exact
 *   connection.
 * - `reconnecting` — the stream dropped. `EventSource` retries on its own.
 */
export type ConnectionState =
  "connecting" | "syncing" | "live" | "reconnecting";

export interface SyncControllerOptions {
  /**
   * Re-queries authoritative state for `route` and renders it. Must reject when
   * the query failed: a failed refresh never counts as a synchronization.
   */
  refresh: (route: DashboardRoute) => Promise<void>;
  /** The route the shell should display right now. */
  currentRoute: () => DashboardRoute;
  /** Called whenever the reported state changes, and never otherwise. */
  onStateChange: (state: ConnectionState) => void;
  schedule: (callback: () => void, delayMs: number) => number;
  cancel: (handle: number) => void;
  /** Coalescing window for invalidate bursts and reconnect storms. */
  debounceMs: number;
}

export interface SyncController {
  /** Loads the initial route. Called once, before the stream is opened. */
  start(): void;
  /** A stream connection was established (`ready`/`open`). */
  streamEstablished(): void;
  /** The stream dropped or errored. */
  streamLost(): void;
  /** An invalidation hint arrived. */
  invalidated(): void;
  /** The location hash changed. */
  routeChanged(): void;
  /** Currently reported state. */
  state(): ConnectionState;
}

/** Stable key for a route, so a navigation invalidates the sync token. */
function routeKey(route: DashboardRoute): string {
  return routeHref(route);
}

export function createSyncController(
  options: SyncControllerOptions,
): SyncController {
  /**
   * Bumped every time a stream connection is established. A refresh that began
   * under an older epoch cannot vouch for the current one.
   */
  let epoch = 0;
  let connected = false;
  let everConnected = false;
  let syncToken: string | null = null;
  let reported: ConnectionState = "connecting";

  /* Single-flight refresh state. Every trigger funnels through it, so no
   * number of `ready`/`invalidate` events can start concurrent fetches. */
  let inFlight = false;
  let queued = false;
  let debounce: number | undefined;

  const currentToken = (): string =>
    `${epoch}:${routeKey(options.currentRoute())}`;

  const computeState = (): ConnectionState => {
    if (!connected) return everConnected ? "reconnecting" : "connecting";
    // Sticky within an epoch: an invalidate refresh does not drop the badge
    // back to `syncing`, because the route *was* already queried under this
    // connection. Only a new connection or a navigation can invalidate it.
    return syncToken === currentToken() ? "live" : "syncing";
  };

  const emit = (): void => {
    const next = computeState();
    if (next === reported) return;
    reported = next;
    options.onStateChange(next);
  };

  const run = async (): Promise<void> => {
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      do {
        queued = false;
        // Route and epoch are captured together, before the await, so the
        // token can only be adopted for the state that was actually fetched.
        const route = options.currentRoute();
        const token = `${epoch}:${routeKey(route)}`;
        emit();
        try {
          await options.refresh(route);
          syncToken = token;
        } catch {
          // The shell renders the failure. Leaving the token unadopted keeps
          // the badge honest: a view that failed to load is not `live`.
        }
        emit();
      } while (queued);
    } finally {
      inFlight = false;
    }
  };

  /**
   * Coalesces bursts — one command publishes several topics, and a flapping
   * connection can fire `ready` repeatedly — into a single refetch.
   */
  const scheduleRefresh = (): void => {
    if (debounce !== undefined) options.cancel(debounce);
    debounce = options.schedule(() => {
      debounce = undefined;
      void run();
    }, options.debounceMs);
  };

  return {
    start(): void {
      emit();
      void run();
    },
    streamEstablished(): void {
      epoch += 1;
      connected = true;
      everConnected = true;
      // The badge reports `syncing` here, not `live`: the connection is up but
      // whatever changed while it was down has not been re-queried yet.
      emit();
      scheduleRefresh();
    },
    streamLost(): void {
      connected = false;
      emit();
    },
    invalidated(): void {
      scheduleRefresh();
    },
    routeChanged(): void {
      // A navigation is a user action; it refreshes immediately rather than
      // waiting out the invalidation debounce. `run` still serializes it.
      emit();
      void run();
    },
    state(): ConnectionState {
      return reported;
    },
  };
}

const stateLabels: Record<ConnectionState, string> = {
  connecting: "connecting",
  syncing: "syncing",
  live: "live",
  reconnecting: "reconnecting",
};

const stateTones: Record<ConnectionState, string> = {
  connecting: "neutral",
  syncing: "active",
  live: "good",
  reconnecting: "attention",
};

export function connectionLabel(state: ConnectionState): string {
  return stateLabels[state];
}

export function connectionTone(state: ConnectionState): string {
  return stateTones[state];
}
