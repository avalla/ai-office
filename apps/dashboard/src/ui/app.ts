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
  GlobalMemoryOverview,
  ProjectDetail,
  TaskDetail,
} from "@ai-office/application/read-models/operational-read-models.ts";
import {
  renderMessage,
  renderOverview,
  renderProject,
  renderRun,
  renderTask,
  renderMemory,
} from "./render.ts";
import {
  connectionLabel,
  connectionTone,
  createSyncController,
  type ConnectionState,
} from "./sync-controller.ts";
import {
  overviewViewModel,
  memoryViewModel,
  parseRoute,
  projectViewModel,
  runViewModel,
  taskViewModel,
  routeHref,
  type DashboardRoute,
} from "./view-model.ts";
import { taskPageParameters } from "@ai-office/application/protocol/query-protocol.ts";
import { taskFilterQuery } from "./task-filters.ts";

const refreshDebounceMs = 250;
let displayedRoute: string | null = null;

/** Ignore responses for a route the user has already left. */
function publishRoute(
  route: DashboardRoute,
  root: DashboardElement,
  html: string,
): boolean {
  const key = routeHref(route);
  if (key !== routeHref(parseRoute(window.location.hash))) return false;
  const controls = ["search", "status", "priority", "agent"].map(
    (name) => `task-filter-${name}`,
  );
  const draft =
    displayedRoute === key
      ? controls.map((id) => ({
          id,
          value: document.getElementById(id)?.value,
        }))
      : [];
  const active = document.activeElement;
  const focused =
    active !== null && controls.includes(active.id)
      ? {
          id: active.id,
          start: active.selectionStart,
          end: active.selectionEnd,
        }
      : null;
  const pageChanged = displayedRoute?.split("?")[0] !== key.split("?")[0];
  root.innerHTML = html;
  for (const field of draft) {
    const element = document.getElementById(field.id);
    if (element !== null && field.value !== undefined)
      element.value = field.value;
  }
  if (pageChanged) {
    root.setAttribute("tabindex", "-1");
    root.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } else if (displayedRoute !== key) {
    const target = document.getElementById("project-tasks");
    target?.setAttribute("tabindex", "-1");
    target?.focus({ preventScroll: true });
  } else if (focused !== null) {
    const element = document.getElementById(focused.id);
    element?.focus({ preventScroll: true });
    if (typeof focused.start === "number" && typeof focused.end === "number")
      element?.setSelectionRange(focused.start, focused.end);
  }
  displayedRoute = key;
  return true;
}

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
    if (route.kind === "invalid") {
      publishRoute(
        route,
        root,
        renderMessage("Invalid task filters", route.message),
      );
      return;
    }
    if (route.kind === "task") {
      const body = await getJson<{ task: TaskDetail }>(
        `/api/projects/${encodeURIComponent(route.projectId)}/tasks/${encodeURIComponent(route.taskId)}`,
      );
      publishRoute(
        route,
        root,
        renderTask(taskViewModel(body.task, route.taskQuery)),
      );
      return;
    }
    if (route.kind === "project") {
      const parameters = taskPageParameters(route.taskQuery ?? {});
      parameters.set("taskView", "paged");
      const body = await getJson<{ project: ProjectDetail }>(
        `/api/projects/${encodeURIComponent(route.projectId)}?${parameters}`,
      );
      if (
        !publishRoute(
          route,
          root,
          renderProject(projectViewModel(body.project)),
        )
      )
        return;
      document
        .getElementById("task-filters")
        ?.addEventListener("submit", (event) => {
          event.preventDefault();
          try {
            const value = (name: string) =>
              document.getElementById(`task-filter-${name}`)?.value ?? "";
            const taskQuery = taskFilterQuery({
              search: value("search"),
              status: value("status"),
              priority: value("priority"),
              agent: value("agent"),
            });
            const destination = routeHref({
              kind: "project",
              projectId: route.projectId,
              taskQuery,
            });
            if (window.location.hash !== destination)
              window.location.hash = destination;
          } catch (error) {
            const message = document.getElementById("task-filter-error");
            if (message !== null)
              message.textContent =
                error instanceof Error ? error.message : "Invalid filters";
          }
        });
      for (const section of ["tasks", "agents", "pipelines"]) {
        document
          .getElementById(`jump-${section}`)
          ?.addEventListener("click", () => {
            const target = document.getElementById(`project-${section}`);
            target?.setAttribute("tabindex", "-1");
            target?.focus({ preventScroll: true });
            target?.scrollIntoView({ block: "start" });
          });
      }
      return;
    }
    if (route.kind === "run") {
      const body = await getJson<{ run: AgentRunDetail }>(
        `/api/runs/${encodeURIComponent(route.runId)}`,
      );
      publishRoute(route, root, renderRun(runViewModel(body.run)));
      return;
    }
    if (route.kind === "memory") {
      const body = await getJson<{ memory: GlobalMemoryOverview }>(
        "/api/memory",
      );
      publishRoute(route, root, renderMemory(memoryViewModel(body.memory)));
      return;
    }
    const body = await getJson<{ dashboard: DashboardOverview }>(
      "/api/dashboard",
    );
    publishRoute(
      route,
      root,
      renderOverview(overviewViewModel(body.dashboard)),
    );
  } catch (error) {
    publishRoute(
      route,
      root,
      renderMessage(
        "Could not load operational state",
        error instanceof Error ? error.message : "Unknown error",
      ),
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
