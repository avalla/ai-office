/**
 * In-memory invalidation bus for the query surface.
 *
 * This bus carries hints, not state. A subscriber learns that some class of
 * data may have changed and re-runs the queries it cares about; it never
 * reconstructs state from the event stream. That keeps the bus from becoming a
 * second, unreliable source of truth, and means a dropped event costs a stale
 * view until the next event or reconnect, never a wrong view.
 *
 * All authoritative writes go through the daemon, so publishing on command
 * completion covers every mutation the runtime performs.
 */

import type {
  QueryEvent,
  QueryEventTopic,
} from "../protocol/query-protocol.ts";

export type QueryEventListener = (event: QueryEvent) => void;

export interface OperationalEventBusOptions {
  /**
   * Hard cap on concurrent subscribers. Refusing the excess is preferable to
   * accumulating listeners a disconnected client will never drain.
   */
  maxSubscribers?: number;
  now?: () => Date;
  /** Reports a listener that threw, so one bad subscriber stays observable. */
  onListenerError?: (error: unknown) => void;
}

export class OperationalEventBusFullError extends Error {
  constructor(limit: number) {
    super(`The operational event bus already has ${limit} subscribers`);
    this.name = "OperationalEventBusFullError";
  }
}

export class OperationalEventBus {
  private readonly listeners = new Set<QueryEventListener>();
  private readonly maxSubscribers: number;
  private readonly now: () => Date;
  private readonly onListenerError: (error: unknown) => void;

  constructor(options: OperationalEventBusOptions = {}) {
    this.maxSubscribers = options.maxSubscribers ?? 64;
    this.now = options.now ?? (() => new Date());
    this.onListenerError = options.onListenerError ?? (() => {});
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  /** Returns an idempotent unsubscribe function. */
  subscribe(listener: QueryEventListener): () => void {
    if (this.listeners.size >= this.maxSubscribers)
      throw new OperationalEventBusFullError(this.maxSubscribers);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Delivers to every current subscriber. A listener that throws is removed and
   * reported; it can never prevent delivery to the others.
   */
  publish(
    topics: readonly QueryEventTopic[],
    context: { projectId?: string } = {},
  ): void {
    if (topics.length === 0 || this.listeners.size === 0) return;
    const occurredAt = this.now().toISOString();
    for (const topic of topics) {
      const event: QueryEvent = {
        topic,
        ...(context.projectId === undefined
          ? {}
          : { projectId: context.projectId }),
        occurredAt,
      };
      for (const listener of [...this.listeners]) {
        try {
          listener(event);
        } catch (error) {
          this.listeners.delete(listener);
          this.onListenerError(error);
        }
      }
    }
  }

  /** Drops every subscriber, for example while the daemon is shutting down. */
  clear(): void {
    this.listeners.clear();
  }
}
