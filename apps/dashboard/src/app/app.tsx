import { useEffect, useRef, useState } from "react";
import { HashRouter, Link, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  Blocks,
  Bot,
  BriefcaseBusiness,
  Database,
  FolderKanban,
  ListTodo,
  Menu,
  Network,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import type { ProjectSummary } from "@ai-office/application/read-models/operational-read-models.ts";
import {
  getProjectSummaries,
  queryRoute,
  type DashboardData,
} from "../api/client.ts";
import {
  createSyncController,
  connectionLabel,
  type ConnectionState,
  type SyncController,
} from "../ui/sync-controller.ts";
import {
  parseRoute,
  routeHref,
  type DashboardRoute,
} from "../ui/view-model.ts";
import {
  Button,
  Select,
  Sheet,
  SheetContent,
  SheetTrigger,
  Skeleton,
} from "../components/ui/primitives.tsx";
import {
  AgentsPage,
  MemoryPage,
  OverviewPage,
  PipelinesPage,
  ProjectGraphPage,
  ProjectPage,
  ProjectsPage,
  RunPage,
  TaskPage,
  WorkPage,
} from "../features/pages.tsx";

type Snapshot = {
  key: string;
  data?: DashboardData;
  error?: string;
  loading: boolean;
};
const navigation = [
  { label: "Overview", path: "/", icon: Activity },
  { label: "Projects", path: "/projects", icon: FolderKanban },
  { label: "Work", path: "/work", icon: BriefcaseBusiness },
  { label: "Pipelines", path: "/pipelines", icon: Blocks },
  { label: "Agents", path: "/agents", icon: Bot },
  { label: "Memory", path: "/memory", icon: Database },
] as const;
const projectNavigation = [
  { label: "Overview", suffix: "", icon: Activity },
  { label: "Pipeline", suffix: "/pipeline", icon: Blocks },
  { label: "Tasks", suffix: "/tasks", icon: ListTodo },
  { label: "Milestones", suffix: "/milestones", icon: FolderKanban },
  { label: "Graph", suffix: "/graph", icon: Network },
  { label: "Requirements", suffix: "/requirements", icon: BriefcaseBusiness },
  { label: "Agents", suffix: "/agents", icon: Bot },
] as const;

export function SidebarLinks({
  currentProject,
  path,
  onNavigate,
}: {
  currentProject: ProjectSummary | null;
  path: string;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Primary navigation" className="space-y-1">
      <p className="sidebar-label">Workspace</p>
      {navigation.map(({ label, path: href, icon: Icon }) => (
        <Link
          key={label}
          to={href}
          onClick={onNavigate}
          aria-current={path === href ? "page" : undefined}
          className="sidebar-link"
        >
          <Icon size={18} aria-hidden="true" />
          {label}
        </Link>
      ))}
      {currentProject && (
        <>
          <div className="my-5 border-t border-border" />
          <p className="sidebar-label truncate" title={currentProject.name}>
            {currentProject.name}
          </p>
          {projectNavigation.map(({ label, suffix, icon: Icon }) => {
            const href = `/projects/${encodeURIComponent(currentProject.projectId)}${suffix}`;
            return (
              <Link
                key={label}
                to={href}
                onClick={onNavigate}
                aria-current={path === href ? "page" : undefined}
                className="sidebar-link"
              >
                <Icon size={17} aria-hidden="true" />
                {label}
              </Link>
            );
          })}
        </>
      )}
    </nav>
  );
}
function ConnectionStatus({
  state,
  loading,
  failed,
}: {
  state: ConnectionState;
  loading: boolean;
  failed: boolean;
}) {
  const bad = state === "reconnecting" || failed;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${bad ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200" : state === "live" && !loading ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "border-border bg-muted text-foreground"}`}
    >
      <span aria-hidden="true">
        {bad ? (
          <WifiOff size={14} />
        ) : loading || state === "syncing" ? (
          <RefreshCw size={14} />
        ) : (
          "●"
        )}
      </span>
      Runtime ·{" "}
      {bad
        ? failed
          ? "stale / query failed"
          : "stale / reconnecting"
        : loading && state === "live"
          ? "refreshing"
          : connectionLabel(state)}
    </div>
  );
}

function DashboardShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const route = parseRoute(window.location.hash);
  const key = routeHref(route);
  const [snapshot, setSnapshot] = useState<Snapshot>({
    key: "",
    loading: true,
  });
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [, setClockTick] = useState(0);
  const controller = useRef<SyncController | null>(null);
  const initialNavigation = useRef(true);
  const currentProjectId =
    route.kind === "project" || route.kind === "task"
      ? route.projectId
      : snapshot.data?.kind === "run"
        ? snapshot.data.detail.run.projectId
        : null;
  const currentProject =
    projects.find((project) => project.projectId === currentProjectId) ?? null;

  useEffect(() => {
    const timer = window.setInterval(
      () => setClockTick((tick) => tick + 1),
      30_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const sync = createSyncController({
      refresh: async (nextRoute: DashboardRoute, isCurrent) => {
        const nextKey = routeHref(nextRoute);
        setSnapshot((previous) => ({
          key: nextKey,
          loading: true,
          ...(previous.data === undefined ? {} : { data: previous.data }),
        }));
        try {
          const [data, list] = await Promise.all([
            queryRoute(nextRoute),
            getProjectSummaries(),
          ]);
          if (!isCurrent()) return;
          setProjects(list);
          setSnapshot({ key: nextKey, data, loading: false });
        } catch (error) {
          if (!isCurrent()) return;
          const message =
            error instanceof Error ? error.message : "Unknown query error";
          setSnapshot({ key: nextKey, error: message, loading: false });
          throw error;
        }
      },
      currentRoute: () => parseRoute(window.location.hash),
      onStateChange: setConnection,
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancel: (timer) => window.clearTimeout(timer),
      debounceMs: 250,
    });
    controller.current = sync;
    const source = new EventSource("/api/events", { withCredentials: true });
    source.addEventListener("ready", () => sync.streamEstablished());
    source.addEventListener("open", () => sync.streamEstablished());
    source.addEventListener("invalidate", () => sync.invalidated());
    source.addEventListener("error", () => sync.streamLost());
    sync.start();
    return () => {
      source.close();
      controller.current = null;
    };
  }, []);

  useEffect(() => {
    if (initialNavigation.current) {
      initialNavigation.current = false;
      return;
    }
    controller.current?.routeChanged();
    window.scrollTo(0, 0);
  }, [location.pathname, location.search]);
  const data = snapshot.key === key ? snapshot.data : undefined;
  const error = snapshot.key === key ? snapshot.error : undefined;
  const loading = snapshot.key !== key || snapshot.loading;
  const path = location.pathname;
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="fixed inset-x-0 top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur sm:px-6">
        <div className="lg:hidden">
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open menu">
                <Menu size={20} />
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SidebarLinks
                currentProject={currentProject}
                path={path}
                onNavigate={() => setSheetOpen(false)}
              />
            </SheetContent>
          </Sheet>
        </div>
        <Link to="/" className="text-lg font-bold tracking-tight">
          AI Office
        </Link>
        <span className="hidden text-xs text-subtle sm:inline">
          Operations console
        </span>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <ConnectionStatus
            state={connection}
            loading={loading}
            failed={error !== undefined}
          />
          <label className="hidden items-center gap-2 text-xs text-subtle sm:flex">
            Project
            <Select
              aria-label="Switch project"
              className="max-w-52"
              value={currentProjectId ?? ""}
              onChange={(event) =>
                navigate(
                  event.target.value
                    ? `/projects/${encodeURIComponent(event.target.value)}`
                    : "/projects",
                )
              }
            >
              <option value="">All projects</option>
              {projects.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.name}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </header>
      <aside className="fixed inset-y-16 left-0 hidden w-60 overflow-y-auto border-r border-border bg-surface px-4 py-6 lg:block">
        <SidebarLinks currentProject={currentProject} path={path} />
        <div className="mt-10 text-xs leading-5 text-subtle">
          Read only · Runtime queries
          <br />
          SSE invalidates the current view
        </div>
      </aside>
      <main id="main" className="min-w-0 pt-16 lg:pl-60">
        <div className="mx-auto max-w-[1480px] px-4 py-7 sm:px-7">
          {error ? (
            <div
              role="alert"
              className="rounded-xl border border-red-300 bg-red-50 p-6 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
            >
              <h1 className="text-xl font-semibold">
                Could not load operational state
              </h1>
              <p className="mt-2">{error}</p>
              <p className="mt-2 text-sm">
                The displayed data is not current. The dashboard will retry on
                reconnection or the next invalidation.
              </p>
            </div>
          ) : !data ? (
            <div role="status" className="space-y-4">
              <Skeleton className="h-9 w-56" />
              <Skeleton className="h-32" />
              <Skeleton className="h-56" />
              <span className="sr-only">Loading operational state</span>
            </div>
          ) : (
            <Page data={data} route={route} currentProject={currentProject} />
          )}
        </div>
      </main>
    </div>
  );
}
function Page({
  data,
  route,
  currentProject,
}: {
  data: DashboardData;
  route: DashboardRoute;
  currentProject: ProjectSummary | null;
}) {
  if (data.kind === "invalid")
    return (
      <div role="alert">
        <h1 className="text-xl font-semibold">Invalid task filters</h1>
        <p>{data.message}</p>
      </div>
    );
  if (data.kind === "overview") return <OverviewPage data={data} />;
  if (data.kind === "projects") return <ProjectsPage data={data} />;
  if (data.kind === "work") return <WorkPage data={data} />;
  if (data.kind === "pipelines") return <PipelinesPage data={data} />;
  if (data.kind === "agents") return <AgentsPage data={data} />;
  if (data.kind === "task")
    return (
      <TaskPage
        data={data}
        {...(route.kind === "task" && route.taskQuery
          ? { taskQuery: route.taskQuery }
          : {})}
      />
    );
  if (data.kind === "run") return <RunPage data={data} />;
  if (data.kind === "memory") return <MemoryPage data={data} />;
  if (data.kind === "graph")
    return <ProjectGraphPage graph={data.graph} project={currentProject} />;
  const section =
    route.kind === "project"
      ? (route.section ?? (route.taskQuery ? "tasks" : undefined))
      : undefined;
  return <ProjectPage data={data} {...(section ? { section } : {})} />;
}
export function App() {
  return (
    <HashRouter>
      <DashboardShell />
    </HashRouter>
  );
}
