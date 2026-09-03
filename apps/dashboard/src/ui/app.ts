/**
 * Dashboard browser shell.
 *
 * The shell owns everything impure: fetching, the invalidation stream, and the
 * single DOM write. Deciding what a thing means happens in the daemon; deciding
 * how it looks happens in `view-model.ts` and `render.ts`; deciding *when* the
 * view is trustworthy happens in `sync-controller.ts`. All three are pure or
 * injected and unit tested, so this file stays small enough to read in one
 * sitting.
 */

import type {
  AgentRunDetail,
  DashboardOverview,
  ProjectDetail,
} from "@ai-office/application/read-models/operational-read-models.ts";
import {
  renderMessage,
  renderOverview,
  renderProject,
  renderRun,
} from "./render.ts";
import {
  connectionLabel,
  connectionTone,
  createSyncController,
  type ConnectionState,
} from "./sync-controller.ts";
import {
  overviewViewModel,
  parseRoute,
  projectViewModel,
  runViewModel,
  type DashboardRoute,
} from "./view-model.ts";

const refreshDebounceMs = 250;

function mount(): DashboardElement {
  const element = document.getElementById("app");
  if (element === null) throw new Error("The dashboard root is missing");
  return element;
}

async function getJson<T>(path: string): Promise<T> {
  // The session cookie is set by the dashboard host on first navigation; it is
  // what lets this same-origin request through.
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(
      body?.error?.message ?? `Request failed with HTTP ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

/**
 * Queries and renders one route. It rethrows after rendering the failure so the
 * sync controller can tell a completed synchronization from a failed one.
 */
async function renderRoute(
  route: DashboardRoute,
  root: DashboardElement,
): Promise<void> {
  try {
    if (route.kind === "project") {
      const body = await getJson<{ project: ProjectDetail }>(
        `/api/projects/${encodeURIComponent(route.projectId)}`,
      );
      root.innerHTML = renderProject(projectViewModel(body.project));
      return;
    }
    if (route.kind === "run") {
      const body = await getJson<{ run: AgentRunDetail }>(
        `/api/runs/${encodeURIComponent(route.runId)}`,
      );
      root.innerHTML = renderRun(runViewModel(body.run));
      return;
    }
    const body = await getJson<{ dashboard: DashboardOverview }>(
      "/api/dashboard",
    );
    root.innerHTML = renderOverview(overviewViewModel(body.dashboard));
  } catch (error) {
    root.innerHTML = renderMessage(
      "Could not load operational state",
      error instanceof Error ? error.message : "Unknown error",
    );
    throw error;
  }
}

function setStatus(state: ConnectionState): void {
  const element = document.getElementById("connection");
  if (element === null) return;
  element.textContent = connectionLabel(state);
  element.setAttribute("data-tone", connectionTone(state));
}

export function start(): void {
  const root = mount();

  const controller = createSyncController({
    refresh: (route) => renderRoute(route, root),
    currentRoute: () => parseRoute(window.location.hash),
    onStateChange: setStatus,
    schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
    cancel: (handle) => window.clearTimeout(handle),
    debounceMs: refreshDebounceMs,
  });

  window.addEventListener("hashchange", () => controller.routeChanged());

  const BrowserEventSource =
    EventSource as unknown as DashboardEventSourceConstructor;
  const source = new BrowserEventSource("/api/events", {
    withCredentials: true,
  });
  // `ready` and `open` both mean "a stream is established". Either one starts a
  // fresh synchronization: the stream carries hints, not state, and it has no
  // replay, so a reconnect alone proves nothing about what is displayed.
  source.addEventListener("ready", () => controller.streamEstablished());
  source.addEventListener("open", () => controller.streamEstablished());
  source.addEventListener("invalidate", () => controller.invalidated());
  // EventSource reconnects on its own; the daemon sends a retry hint. The
  // status line exists so a stale view is never mistaken for a live one.
  source.addEventListener("error", () => controller.streamLost());

  controller.start();
}
