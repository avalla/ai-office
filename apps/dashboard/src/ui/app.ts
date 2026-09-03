/**
 * Dashboard browser shell.
 *
 * The shell owns everything impure: fetching, the invalidation stream, and the
 * single DOM write. Deciding what a thing means happens in the daemon; deciding
 * how it looks happens in `view-model.ts` and `render.ts`. Both of those are
 * pure and unit tested, so this file stays small enough to read in one sitting.
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
  }
}

function setStatus(text: string, tone: string): void {
  const element = document.getElementById("connection");
  if (element === null) return;
  element.textContent = text;
  element.setAttribute("data-tone", tone);
}

export function start(): void {
  const root = mount();
  let pending: number | undefined;
  let inFlight = false;
  let queued = false;

  const refresh = async () => {
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      await renderRoute(parseRoute(window.location.hash), root);
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        void refresh();
      }
    }
  };

  // Invalidation events arrive in bursts — one command can publish several
  // topics — so coalesce them into a single refetch.
  const scheduleRefresh = () => {
    if (pending !== undefined) window.clearTimeout(pending);
    pending = window.setTimeout(() => {
      pending = undefined;
      void refresh();
    }, refreshDebounceMs);
  };

  window.addEventListener("hashchange", () => {
    void refresh();
  });

  const BrowserEventSource =
    EventSource as unknown as DashboardEventSourceConstructor;
  const source = new BrowserEventSource("/api/events", {
    withCredentials: true,
  });
  source.addEventListener("ready", () => setStatus("live", "good"));
  source.addEventListener("invalidate", () => scheduleRefresh());
  source.addEventListener("error", () =>
    // EventSource reconnects on its own; the daemon sends a retry hint. The
    // status line exists so a stale view is never mistaken for a live one.
    setStatus("reconnecting", "attention"),
  );
  source.addEventListener("open", () => setStatus("live", "good"));

  void refresh();
}
