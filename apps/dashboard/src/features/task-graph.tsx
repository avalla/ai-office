import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Hourglass } from "lucide-react";
import { Link } from "react-router-dom";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type {
  TaskDetail,
  TaskGraph,
  TaskGraphMilestone,
  TaskGraphNode,
  TaskOperationalStatus,
  TaskOperationalState,
} from "@ai-office/application/read-models/operational-read-models.ts";
import { getTaskDetail } from "../api/client.ts";
import { Empty, Section, StatusBadge } from "../components/operations.tsx";
import { Button, Input, Select, cn } from "../components/ui/primitives.tsx";
import {
  blockers,
  unmetEdgeKeys,
  chainPage,
  chainPageSize,
  createGraphRelationshipMemo,
  createLayoutMemo,
  decideFraming,
  exceedsLayoutLimit,
  maxLayoutWeight,
  nodeStateLabel,
  idleState,
  statusLabel,
  defaultGraphFilters,
  filterGraph,
  nodeSize,
  otherDependentIds,
  quickFilters,
  searchTasks,
  taskKey,
  type GraphDirection,
  type GraphFilters,
  type QuickFilter,
} from "../lib/task-graph.ts";
import {
  requirementStatusTone,
  taskStatusTone,
  type ToneName,
} from "../ui/view-model.ts";

/* -------------------------------------------------------------------------- */
/* Colours (fixed so SVG markers render the same in light and dark mode)       */
/* -------------------------------------------------------------------------- */

/**
 * Few meanings, few colours. Meaning is never colour alone: unmet edges are
 * dashed, the chain is thicker, and the legend and side panel say it in text.
 */
const colour = {
  neutral: "#8b95a7",
  unmet: "#d97706",
  lineage: "#2563eb",
  chain: "#dc2626",
} as const;

const miniMapColour: Record<ToneName, string> = {
  neutral: "#94a3b8",
  active: "#3b82f6",
  attention: "#f59e0b",
  good: "#10b981",
  muted: "#cbd5e1",
};

const statusOptions: readonly TaskOperationalStatus[] = [
  "not_started",
  "scheduled",
  "in_progress",
  "awaiting_review",
  "blocked",
  "failed",
  "completed",
  "cancelled",
];

const quickLabels: Record<QuickFilter, string> = {
  ready: "Ready",
  waiting: "Waiting on prerequisites",
  blocked: "Blocked",
  in_progress: "In progress",
  attention: "Needs attention",
};

/* -------------------------------------------------------------------------- */
/* Nodes                                                                       */
/* -------------------------------------------------------------------------- */

interface TaskNodeData extends Record<string, unknown> {
  task: TaskGraphNode;
  /** First milestone title, and how many more the task belongs to. */
  milestone: { title: string; more: number } | null;
  dimmed: boolean;
  selected: boolean;
  onChain: boolean;
  direction: GraphDirection;
  onSelect: (key: string) => void;
}

type TaskFlowNode = Node<TaskNodeData, "task">;

const hiddenHandle = "!h-1 !w-1 !border-0 !bg-transparent !min-h-0 !min-w-0";

function TaskNodeView({ data }: NodeProps<TaskFlowNode>) {
  const { task, milestone } = data;
  const target = data.direction === "LR" ? Position.Left : Position.Top;
  const source = data.direction === "LR" ? Position.Right : Position.Bottom;
  const waitingOn = task.unmetPrerequisiteIds.length;
  const state = nodeStateLabel(task);
  return (
    <>
      <Handle
        type="target"
        position={target}
        className={hiddenHandle}
        isConnectable={false}
      />
      <button
        type="button"
        aria-pressed={data.selected}
        aria-label={`${task.title}. ${statusLabel(task.operationalStatus)}. ${state}. Priority ${task.priority}.${
          milestone === null
            ? ""
            : ` Milestone ${milestone.title}${milestone.more > 0 ? ` and ${milestone.more} more` : ""}.`
        }`}
        onClick={() => data.onSelect(taskKey(task.taskId))}
        style={{ width: nodeSize.width, height: nodeSize.height }}
        className={cn(
          "flex cursor-pointer flex-col justify-between rounded-lg border bg-surface px-3 py-2 text-left shadow-sm transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          data.selected
            ? "border-primary ring-2 ring-primary"
            : data.onChain
              ? "border-red-500"
              : "border-border",
          data.dimmed && "opacity-25",
        )}
      >
        <span className="line-clamp-2 text-sm font-medium leading-snug">
          {task.title}
        </span>
        <span className="flex items-center justify-between gap-2 [&_span]:whitespace-nowrap">
          <StatusBadge
            label={statusLabel(task.operationalStatus)}
            tone={taskStatusTone(task.operationalStatus)}
          />
          {milestone !== null && (
            <span
              title={`Milestone: ${milestone.title}`}
              className="max-w-[8rem] truncate rounded border border-border bg-muted px-1.5 text-xs text-subtle"
            >
              {milestone.title}
              {milestone.more > 0 && ` +${milestone.more}`}
            </span>
          )}
        </span>
        <span className="flex items-center justify-between gap-2 text-xs tabular-nums">
          {task.ready ? (
            <span className="rounded border border-emerald-400 px-1 font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-600 dark:text-emerald-300">
              Ready
            </span>
          ) : task.waiting ? (
            <span
              title={`${blockers(waitingOn)}: prerequisites not completed`}
              className="rounded border border-amber-400 px-1 text-amber-800 dark:text-amber-300"
            >
              <Hourglass aria-hidden="true" className="mr-1 inline h-3 w-3" />
              {blockers(waitingOn)}
            </span>
          ) : (
            <span />
          )}
          <span className="text-subtle" title="Priority">
            P{task.priority}
          </span>
        </span>
      </button>
      <Handle
        type="source"
        position={source}
        className={hiddenHandle}
        isConnectable={false}
      />
    </>
  );
}

const nodeTypes = { task: TaskNodeView };

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

const readableZoom = 0.7;
/** How long a focus jump may wait for the layout pass it triggered. */
const pendingFocusWindow = 800;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export function TaskGraphView({
  graph,
  projectId,
}: {
  graph: TaskGraph;
  projectId: string;
}) {
  return (
    <ReactFlowProvider key={projectId}>
      <TaskGraphCanvas graph={graph} projectId={projectId} />
    </ReactFlowProvider>
  );
}

function TaskGraphCanvas({
  graph,
  projectId,
}: {
  graph: TaskGraph;
  projectId: string;
}) {
  const [filters, setFilters] = useState<GraphFilters>(defaultGraphFilters);
  const [query, setQuery] = useState("");
  const [filterByQuery, setFilterByQuery] = useState(false);
  const [searchOpen, setSearchOpen] = useState(true);
  const [direction, setDirection] = useState<GraphDirection>("LR");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focusOnly, setFocusOnly] = useState(false);
  const [showChain, setShowChain] = useState(true);
  const [showMinimap, setShowMinimap] = useState(true);
  const [readyPageIndex, setReadyPageIndex] = useState(0);
  const [attentionPageIndex, setAttentionPageIndex] = useState(0);
  const [chainPageIndex, setChainPageIndex] = useState(0);
  const [memoizedLayout] = useState(createLayoutMemo);
  const [memoizedRelationships] = useState(createGraphRelationshipMemo);
  const { fitView, setViewport } = useReactFlow();

  const patch = (change: Partial<GraphFilters>) =>
    setFilters((current) => ({ ...current, ...change }));
  // Searching locates by default; it filters only when asked to.
  const appliedSearch = filterByQuery ? query : "";
  const effectiveFilters = useMemo(
    () => ({ ...filters, search: appliedSearch }),
    [filters, appliedSearch],
  );

  const tasksById = useMemo(
    () => new Map(graph.tasks.map((task) => [task.taskId, task])),
    [graph.tasks],
  );
  const unmetPairs = useMemo(() => unmetEdgeKeys(graph.tasks), [graph.tasks]);
  const milestonesById = useMemo(
    () => new Map(graph.milestones.map((m) => [m.milestoneId, m])),
    [graph.milestones],
  );

  // A live refresh can remove the selected task; never keep a dangling one.
  const staleReset = useRef(false);
  const selectedTask =
    selectedKey === null ? null : (tasksById.get(selectedKey.slice(2)) ?? null);
  const selectedTaskId = selectedTask?.taskId ?? null;
  const [detailRequest, setDetailRequest] = useState(0);
  const [detailState, setDetailState] = useState<{
    graph: TaskGraph;
    taskId: string;
    detail: TaskDetail | null;
    error: boolean;
  } | null>(null);

  useEffect(() => {
    if (selectedTaskId === null) return;
    const controller = new AbortController();
    void getTaskDetail(projectId, selectedTaskId, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted)
          setDetailState({
            graph,
            taskId: selectedTaskId,
            detail,
            error: false,
          });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setDetailState({
            graph,
            taskId: selectedTaskId,
            detail: null,
            error: true,
          });
      });
    return () => controller.abort();
  }, [detailRequest, graph, projectId, selectedTaskId]);

  const currentDetail =
    detailState?.graph === graph && detailState.taskId === selectedTaskId
      ? detailState
      : null;

  // A selection that a live refresh removed must not come back with its
  // isolation if the id reappears.
  useEffect(() => {
    if (selectedKey !== null && selectedTask === null) {
      // Data-driven, not a user clear: it must not count as one when framing.
      staleReset.current = true;
      setSelectedKey(null);
      setFocusOnly(false);
    }
  }, [selectedKey, selectedTask]);

  const selectedRelationships = useMemo(
    () =>
      selectedTask === null
        ? null
        : memoizedRelationships(graph.edges, selectedTask.taskId),
    [graph.edges, selectedTask, memoizedRelationships],
  );
  const selectedLineage = selectedRelationships?.lineage ?? null;
  const related = useMemo(
    () =>
      selectedTask === null || selectedLineage === null
        ? null
        : new Set([
            selectedTask.taskId,
            ...selectedLineage.upstream,
            ...selectedLineage.downstream,
          ]),
    [selectedLineage, selectedTask],
  );

  const visible = useMemo(
    () =>
      filterGraph(graph, effectiveFilters, {
        ...(selectedTask === null
          ? {}
          : { keep: new Set([selectedTask.taskId]) }),
        ...(focusOnly && related !== null ? { only: related } : {}),
      }),
    [effectiveFilters, focusOnly, graph, related, selectedTask],
  );

  const tooLarge = exceedsLayoutLimit(
    visible.tasks.length,
    visible.edges.length,
  );
  const positions = useMemo(
    () =>
      tooLarge
        ? new Map<string, { x: number; y: number }>()
        : memoizedLayout(visible, direction),
    [tooLarge, visible, direction, memoizedLayout],
  );

  const chainIds = useMemo(
    () => new Set(showChain ? graph.longestDependencyChain : []),
    [graph.longestDependencyChain, showChain],
  );
  const chainEdges = useMemo(() => {
    const pairs = new Set<string>();
    if (!showChain) return pairs;
    const chain = graph.longestDependencyChain;
    for (let i = 1; i < chain.length; i += 1)
      pairs.add(`${chain[i - 1]}>${chain[i]}`);
    return pairs;
  }, [graph.longestDependencyChain, showChain]);

  const select = useCallback(
    (key: string) =>
      setSelectedKey((current) => (current === key ? null : key)),
    [],
  );

  const nodes = useMemo<TaskFlowNode[]>(() => {
    const result: TaskFlowNode[] = [];
    for (const task of visible.tasks) {
      const position = positions.get(taskKey(task.taskId));
      if (position === undefined) continue;
      const first = milestonesById.get(task.milestoneIds[0] ?? "");
      result.push({
        id: taskKey(task.taskId),
        type: "task",
        position,
        width: nodeSize.width,
        height: nodeSize.height,
        draggable: false,
        connectable: false,
        focusable: false,
        // React Flow otherwise disables pointer events when its own selection
        // and dragging are off; the button still needs real mouse clicks.
        style: { pointerEvents: "all" },
        data: {
          task,
          direction,
          milestone:
            first === undefined
              ? null
              : { title: first.title, more: task.milestoneIds.length - 1 },
          selected: selectedKey === taskKey(task.taskId),
          onChain: chainIds.has(task.taskId),
          dimmed: related !== null && !related.has(task.taskId),
          onSelect: select,
        },
      });
    }
    // DOM order is keyboard order: follow the flow, not the id sort.
    const along = (node: { position: { x: number; y: number } }) =>
      direction === "LR"
        ? [node.position.x, node.position.y]
        : [node.position.y, node.position.x];
    return result.sort((a, b) => {
      const [a1, a2] = along(a);
      const [b1, b2] = along(b);
      return a1! - b1! || a2! - b2!;
    });
  }, [
    chainIds,
    direction,
    milestonesById,
    positions,
    related,
    select,
    selectedKey,
    visible.tasks,
  ]);

  const edges = useMemo<Edge[]>(() => {
    const lineageScope =
      selectedTask !== null && selectedLineage !== null
        ? {
            up: new Set([selectedTask.taskId, ...selectedLineage.upstream]),
            down: new Set([selectedTask.taskId, ...selectedLineage.downstream]),
          }
        : null;
    if (tooLarge) return [];
    return visible.edges.map((edge) => {
      const unmet = unmetPairs.has(`${edge.dependsOnTaskId}>${edge.taskId}`);
      const onLineage =
        lineageScope !== null &&
        ((lineageScope.up.has(edge.taskId) &&
          lineageScope.up.has(edge.dependsOnTaskId)) ||
          (lineageScope.down.has(edge.taskId) &&
            lineageScope.down.has(edge.dependsOnTaskId)));
      const onChain = chainEdges.has(`${edge.dependsOnTaskId}>${edge.taskId}`);
      const stroke = onLineage
        ? colour.lineage
        : onChain
          ? colour.chain
          : unmet
            ? colour.unmet
            : colour.neutral;
      return {
        id: `d:${edge.dependsOnTaskId}>${edge.taskId}`,
        source: taskKey(edge.dependsOnTaskId),
        target: taskKey(edge.taskId),
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        style: {
          stroke,
          strokeWidth: onLineage || onChain ? 3 : 1.5,
          // Every unmet prerequisite stays dashed, even for a terminal task.
          strokeDasharray: unmet ? "6 4" : "none",
          opacity:
            lineageScope !== null && !onLineage ? 0.12 : unmet ? 1 : 0.55,
        },
      };
    });
  }, [
    chainEdges,
    selectedLineage,
    selectedTask,
    tooLarge,
    unmetPairs,
    visible.edges,
  ]);

  // Isolation belongs to one selection: choosing another item, or clearing,
  // ends it.
  useEffect(() => {
    setFocusOnly(false);
  }, [selectedKey]);

  const canvasRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  /**
   * Frame the whole graph, but never below a readable zoom: a long chain fitted
   * entirely into view is unreadable, so past that floor the view starts at the
   * beginning of the flow and the minimap and Fit control cover the rest.
   */
  const frame = () => {
    const element = canvasRef.current;
    if (element === null || positions.size === 0) return;
    const boxes = [...positions.values()];
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const width = Math.max(...boxes.map((b) => b.x)) + nodeSize.width - minX;
    const height = Math.max(...boxes.map((b) => b.y)) + nodeSize.height - minY;
    const margin = 32;
    const fit = Math.min(
      (element.clientWidth - 2 * margin) / width,
      (element.clientHeight - 2 * margin) / height,
      1,
    );
    const zoom = Math.max(fit, readableZoom);
    const place = (size: number, available: number, origin: number) =>
      size * zoom <= available
        ? (available - size * zoom) / 2 - origin * zoom
        : margin - origin * zoom;
    markProgrammatic(prefersReducedMotion() ? 0 : 200);
    void setViewport(
      {
        x: place(width, element.clientWidth, minX),
        y: place(height, element.clientHeight, minY),
        zoom,
      },
      { duration: prefersReducedMotion() ? 0 : 200 },
    );
  };
  const frameRef = useRef(frame);
  frameRef.current = frame;
  // A focus jump that also changes the layout must win over the automatic
  // framing, whichever animation frame runs last.
  const pendingFocus = useRef<{ key: string; at: number } | null>(null);
  const focusNode = (key: string) => {
    markProgrammatic(prefersReducedMotion() ? 0 : 250);
    return fitView({
      nodes: [{ id: key }],
      maxZoom: 1.1,
      padding: 0.6,
      duration: prefersReducedMotion() ? 0 : 250,
    });
  };
  // Re-frame whenever the computed layout changes, whatever caused it. The one
  // exception is a data-driven change (a live refresh, no user action) after the
  // user has moved the viewport: their view is left alone.
  const layoutKey = useMemo(
    () =>
      [...positions]
        .map(([id, at]) => `${id}@${Math.round(at.x)},${Math.round(at.y)}`)
        .join("|"),
    [positions],
  );
  const actionKey = `${direction}|${focusOnly}|${JSON.stringify(effectiveFilters)}`;
  const userMoved = useRef(false);
  const lastAction = useRef<string | null>(null);
  const selectedKeyRef = useRef(selectedKey);
  selectedKeyRef.current = selectedKey;
  // Our own animated moves (frame, focus) must not look like the user's. Any
  // move outside that window is the user's: wheel, drag, Controls or minimap.
  const programmaticUntil = useRef(0);
  const markProgrammatic = (duration: number) => {
    programmaticUntil.current = Date.now() + duration + 150;
  };
  // Clearing a selection is a user action even when it only removes a node that
  // was kept visible past the filters. The flag lives for one framing pass: it
  // is consumed there, or dropped two frames later when the layout did not move.
  const clearedSelection = useRef(false);
  const previousSelection = useRef<string | null>(null);
  useEffect(() => {
    if (selectedKey === null && previousSelection.current !== null) {
      if (staleReset.current) staleReset.current = false;
      else {
        clearedSelection.current = true;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearedSelection.current = false;
          }),
        );
      }
    }
    previousSelection.current = selectedKey;
  }, [selectedKey]);
  useEffect(() => {
    const handle = requestAnimationFrame(() => {
      const pending = pendingFocus.current;
      pendingFocus.current = null;
      const decision = decideFraming({
        pendingKey:
          pending !== null && Date.now() - pending.at < pendingFocusWindow
            ? pending.key
            : null,
        selectedKey: selectedKeyRef.current,
        actionChanged: lastAction.current !== actionKey,
        cleared: clearedSelection.current,
        userMoved: userMoved.current,
      });
      lastAction.current = actionKey;
      clearedSelection.current = false;
      if (decision === "focus" && pending !== null) {
        userMoved.current = false;
        void focusNode(pending.key);
      } else if (decision === "frame") {
        userMoved.current = false;
        frameRef.current();
      }
    });
    return () => cancelAnimationFrame(handle);
  }, [layoutKey, actionKey]);

  const clearSelection = () => {
    const focusWasInPanel = asideRef.current?.contains(document.activeElement);
    setSelectedKey(null);
    // The panel content unmounts; keep keyboard focus inside the region.
    if (focusWasInPanel) requestAnimationFrame(() => asideRef.current?.focus());
  };

  const focusOn = (key: string) => {
    // Activating a panel list item replaces the panel content; keep focus there.
    const focusWasInPanel = asideRef.current?.contains(document.activeElement);
    const at = Date.now();
    pendingFocus.current = { key, at };
    // A jump that changes no layout never reaches the framing pass; drop its
    // pending focus so it cannot override a later, unrelated re-frame.
    window.setTimeout(() => {
      if (pendingFocus.current?.at === at) pendingFocus.current = null;
    }, pendingFocusWindow);
    setSelectedKey(key);
    requestAnimationFrame(() => {
      void focusNode(key);
      if (focusWasInPanel) asideRef.current?.focus();
    });
  };
  const searchRef = useRef<HTMLInputElement>(null);
  // Returning focus to the input after a jump must not reopen the results.
  const refocusingSearch = useRef(false);
  const locate = (key: string) => {
    focusOn(key);
    setSearchOpen(false);
    // The result button that held focus is about to unmount.
    requestAnimationFrame(() => {
      // focus() dispatches its event synchronously, so the flag cannot leak.
      refocusingSearch.current = true;
      searchRef.current?.focus();
      refocusingSearch.current = false;
    });
  };

  const fitGraph = () => {
    userMoved.current = false;
    frame();
  };

  const search = useMemo(() => searchTasks(graph, query), [graph, query]);

  const byPriority = (a: TaskGraphNode, b: TaskGraphNode) =>
    b.priority - a.priority || a.taskId.localeCompare(b.taskId);
  const readyTasks = useMemo(
    () => graph.tasks.filter((t) => t.ready).sort(byPriority),
    [graph.tasks],
  );
  const attentionTasks = useMemo(
    () => graph.tasks.filter((t) => t.needsAttention).sort(byPriority),
    [graph.tasks],
  );
  const canvasUnavailable = tooLarge || visible.tasks.length === 0;

  const filtered =
    query !== "" ||
    filters.status !== "" ||
    filters.milestone !== "" ||
    filters.quick !== "" ||
    !filters.hideCompleted;

  if (graph.tasks.length === 0)
    return (
      <Section title="Dependency graph">
        <Empty>This project has no tasks yet.</Empty>
      </Section>
    );

  return (
    <Section
      title="Dependency graph"
      detail={`${graph.tasks.length} tasks · ${graph.edges.length} dependencies`}
    >
      <ul
        aria-label="Operational summary"
        className="flex flex-wrap gap-2 text-sm"
      >
        {quickFilters.map((quick) => (
          <li key={quick}>
            <button
              type="button"
              aria-pressed={filters.quick === quick}
              onClick={() =>
                patch({ quick: filters.quick === quick ? "" : quick })
              }
              className="flex items-baseline gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary aria-pressed:bg-muted"
            >
              <span className="text-lg font-semibold tabular-nums">
                {
                  graph.summary[
                    quick === "attention"
                      ? "needsAttention"
                      : quick === "in_progress"
                        ? "inProgress"
                        : quick
                  ]
                }
              </span>
              <span className="text-subtle">{quickLabels[quick]}</span>
            </button>
          </li>
        ))}
      </ul>

      <form
        className="flex flex-wrap items-end gap-3"
        role="search"
        aria-label="Graph filters"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="relative flex min-w-56 flex-1 flex-col gap-1 text-xs text-subtle">
          <label htmlFor="graph-search">Find a task</label>
          <Input
            ref={searchRef}
            id="graph-search"
            type="search"
            value={query}
            placeholder="Title or id, Enter to jump"
            onChange={(event) => {
              setQuery(event.target.value);
              setSearchOpen(true);
            }}
            onFocus={() => {
              if (!refocusingSearch.current) setSearchOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSearchOpen(false);
              const first = search.matches[0];
              if (
                event.key === "Enter" &&
                !filterByQuery &&
                first !== undefined
              )
                locate(taskKey(first.taskId));
            }}
          />
          <p className="sr-only" aria-live="polite">
            {query.trim() === "" || filterByQuery
              ? ""
              : `${search.total} matching task${search.total === 1 ? "" : "s"}`}
          </p>
          {query.trim() !== "" && !filterByQuery && searchOpen && (
            <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border border-border bg-surface p-1 text-sm text-foreground shadow-lg">
              {search.total === 0 ? (
                <p className="px-2 py-1 text-subtle">No task matches.</p>
              ) : (
                <>
                  <ul>
                    {search.matches.map((task) => (
                      <li key={task.taskId}>
                        <button
                          type="button"
                          className="flex w-full justify-between gap-2 rounded px-2 py-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => locate(taskKey(task.taskId))}
                        >
                          <span className="truncate">{task.title}</span>
                          <span className="shrink-0 text-xs text-subtle">
                            {statusLabel(task.operationalStatus)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {search.total > search.matches.length && (
                    <p className="px-2 py-1 text-xs text-subtle">
                      {search.total - search.matches.length} more; refine the
                      text or filter the graph.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        <label className="flex flex-col gap-1 text-xs text-subtle">
          Status
          <Select
            value={filters.status}
            onChange={(event) =>
              patch({
                status: event.target.value as TaskOperationalStatus | "",
              })
            }
          >
            <option value="">All statuses</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {statusLabel(status)}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-subtle">
          Milestone
          <Select
            value={filters.milestone}
            onChange={(event) => patch({ milestone: event.target.value })}
          >
            <option value="">All milestones</option>
            <option value="none">No milestone</option>
            {graph.milestones.map((m) => (
              <option key={m.milestoneId} value={m.milestoneId}>
                {m.title}
              </option>
            ))}
          </Select>
        </label>
        <details className="relative text-sm">
          <summary className="flex h-10 cursor-pointer items-center rounded-md border border-border bg-surface px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            More filters
          </summary>
          <div className="absolute right-0 z-20 mt-2 flex w-72 flex-col gap-2 rounded-md border border-border bg-surface p-3 shadow-lg">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={filters.hideCompleted}
                onChange={(event) =>
                  patch({ hideCompleted: event.target.checked })
                }
              />
              Hide completed and nonblocking cancelled
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={filterByQuery}
                onChange={(event) => setFilterByQuery(event.target.checked)}
              />
              Show only tasks matching the search
            </label>
            <label className="flex flex-col gap-1 text-xs text-subtle">
              Operational view
              <Select
                value={filters.quick}
                onChange={(event) =>
                  patch({ quick: event.target.value as QuickFilter | "" })
                }
              >
                <option value="">All tasks</option>
                {quickFilters.map((quick) => (
                  <option key={quick} value={quick}>
                    {quickLabels[quick]}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        </details>
        {filtered && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setFilters(defaultGraphFilters);
              setQuery("");
              setFilterByQuery(false);
            }}
          >
            Reset filters
          </Button>
        )}
      </form>

      <div
        className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(18rem,1fr)]"
        onKeyDown={(event) => {
          if (event.key === "Escape" && selectedKey !== null) clearSelection();
        }}
      >
        <div className="flex min-w-0 flex-col gap-2">
          <div
            ref={canvasRef}
            className="h-[70vh] min-h-[26rem] overflow-hidden rounded-xl border border-border bg-surface"
          >
            {visible.tasks.length === 0 ? (
              <div className="p-6">
                <Empty>No tasks match these filters.</Empty>
              </div>
            ) : tooLarge ? (
              <div className="p-6" role="status">
                <Empty>
                  {visible.tasks.length.toLocaleString()} tasks and{" "}
                  {visible.edges.length.toLocaleString()} dependencies match.
                  The graph can lay out at most{" "}
                  {maxLayoutWeight.toLocaleString()} combined tasks and
                  dependencies. Narrow the view with a summary shortcut, a
                  status or milestone filter, or select a task from the lists
                  and use &ldquo;Only this lineage&rdquo;. Summary counts remain
                  complete. Search can find any task; ready, attention, and
                  chain lists are paged.
                </Empty>
              </div>
            ) : (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                minZoom={0.05}
                maxZoom={1.75}
                nodesDraggable={false}
                nodesConnectable={false}
                nodesFocusable={false}
                edgesFocusable={false}
                elementsSelectable={false}
                onlyRenderVisibleElements
                onMove={() => {
                  // Fires only when the transform really changes (a click does
                  // not), from any source; ours are inside the programmatic
                  // window.
                  if (Date.now() > programmaticUntil.current)
                    userMoved.current = true;
                }}
                onPaneClick={clearSelection}
                proOptions={{ hideAttribution: true }}
                aria-label="Task dependency graph. The side panel lists give keyboard access to ready, attention and related tasks."
              >
                <Background gap={24} />
                <Controls showInteractive={false} showFitView={false} />
                {showMinimap && (
                  <MiniMap
                    className="!hidden sm:!block"
                    pannable
                    zoomable
                    nodeColor={(node) =>
                      miniMapColour[
                        taskStatusTone(
                          (node.data as TaskNodeData).task.operationalStatus,
                        )
                      ]
                    }
                    bgColor="hsl(var(--surface))"
                    maskColor="rgba(120,130,150,0.18)"
                  />
                )}
              </ReactFlow>
            )}
          </div>
          <div
            role="group"
            aria-label="Graph view"
            className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm"
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={fitGraph}
              disabled={canvasUnavailable}
            >
              Fit graph
            </Button>
            <div
              role="group"
              aria-label="Layout direction"
              className="flex gap-1"
            >
              {(
                [
                  ["LR", "Left → right"],
                  ["TB", "Top ↓ down"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={direction === value ? "default" : "outline"}
                  aria-pressed={direction === value}
                  onClick={() => setDirection(value)}
                  disabled={canvasUnavailable}
                >
                  {label}
                </Button>
              ))}
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={showChain}
                onChange={(event) => setShowChain(event.target.checked)}
                disabled={canvasUnavailable}
              />
              Longest dependency chain
            </label>
            <label className="hidden items-center gap-2 sm:flex">
              <input
                type="checkbox"
                checked={showMinimap}
                onChange={(event) => setShowMinimap(event.target.checked)}
                disabled={canvasUnavailable}
              />
              Minimap
            </label>
            <span className="text-xs text-subtle tabular-nums">
              Showing {visible.tasks.length} of {graph.tasks.length} tasks
            </span>
          </div>
        </div>

        <aside
          ref={asideRef}
          tabIndex={-1}
          aria-label="What happens next"
          className="flex max-h-[70vh] min-h-0 flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-surface p-4 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {selectedTask !== null && selectedRelationships !== null ? (
            <TaskPanel
              key={selectedTask.taskId}
              projectId={projectId}
              task={selectedTask}
              detail={currentDetail?.detail ?? null}
              detailLoading={currentDetail === null}
              detailError={currentDetail?.error ?? false}
              onRetryDetail={() => {
                setDetailState(null);
                setDetailRequest((request) => request + 1);
              }}
              tasksById={tasksById}
              prerequisites={selectedRelationships.prerequisites}
              dependents={selectedRelationships.dependents}
              lineage={selectedRelationships.lineage}
              milestones={selectedTask.milestoneIds.flatMap((id) => {
                const m = milestonesById.get(id);
                return m === undefined ? [] : [m];
              })}
              focusOnly={focusOnly}
              onFocusOnly={setFocusOnly}
              onFocus={focusOn}
              onClear={clearSelection}
            />
          ) : (
            <OverviewTaskLists
              readyTasks={readyTasks}
              attentionTasks={attentionTasks}
              chainIds={graph.longestDependencyChain}
              tasksById={tasksById}
              readyPageIndex={readyPageIndex}
              attentionPageIndex={attentionPageIndex}
              chainPageIndex={chainPageIndex}
              onReadyPageChange={setReadyPageIndex}
              onAttentionPageChange={setAttentionPageIndex}
              onChainPageChange={setChainPageIndex}
              onFocus={focusOn}
            />
          )}
        </aside>
      </div>
      {graph.edges.length === 0 && (
        <p className="text-xs text-subtle">
          No task dependencies are recorded yet. Add one with{" "}
          <code>ai-office task:dependency:add</code>.
        </p>
      )}
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/* Side panel                                                                  */
/* -------------------------------------------------------------------------- */

export function OverviewTaskLists({
  readyTasks,
  attentionTasks,
  chainIds,
  tasksById,
  readyPageIndex,
  attentionPageIndex,
  chainPageIndex,
  onReadyPageChange,
  onAttentionPageChange,
  onChainPageChange,
  onFocus,
}: {
  readyTasks: readonly TaskGraphNode[];
  attentionTasks: readonly TaskGraphNode[];
  chainIds: readonly string[];
  tasksById: ReadonlyMap<string, TaskGraphNode>;
  readyPageIndex: number;
  attentionPageIndex: number;
  chainPageIndex: number;
  onReadyPageChange: (page: number) => void;
  onAttentionPageChange: (page: number) => void;
  onChainPageChange: (page: number) => void;
  onFocus: (key: string) => void;
}) {
  const longestChainPage = chainPage(chainIds, tasksById, chainPageIndex);
  const readyIds = useMemo(
    () => readyTasks.map((task) => task.taskId),
    [readyTasks],
  );
  const attentionIds = useMemo(
    () => attentionTasks.map((task) => task.taskId),
    [attentionTasks],
  );
  return (
    <>
      <PagedTaskList
        title="Ready to start"
        empty="Nothing is ready."
        ids={readyIds}
        tasksById={tasksById}
        requestedPage={readyPageIndex}
        onRequestedPageChange={onReadyPageChange}
        showPriority
        onFocus={onFocus}
      />
      <PagedTaskList
        title="Needs attention"
        empty="Nothing needs attention."
        ids={attentionIds}
        tasksById={tasksById}
        requestedPage={attentionPageIndex}
        onRequestedPageChange={onAttentionPageChange}
        showPriority
        onFocus={onFocus}
      />
      <TaskList
        title="Longest dependency chain"
        empty="No chain of dependent unfinished tasks."
        tasks={longestChainPage.tasks}
        ordered
        start={longestChainPage.page * chainPageSize + 1}
        onFocus={onFocus}
      />
      <TaskListPager
        title="Longest dependency chain"
        page={longestChainPage.page}
        totalPages={longestChainPage.totalPages}
        onPageChange={onChainPageChange}
      />
      <Legend />
    </>
  );
}

function TaskList({
  title,
  tasks,
  empty,
  onFocus,
  ordered = false,
  start,
  showPriority = false,
}: {
  title: string;
  tasks: readonly TaskGraphNode[];
  empty: string;
  onFocus: (key: string) => void;
  ordered?: boolean;
  start?: number;
  showPriority?: boolean;
}) {
  const List = ordered ? "ol" : "ul";
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">
        {title}
      </h3>
      {tasks.length === 0 ? (
        <p className="text-xs text-subtle">{empty}</p>
      ) : (
        <List
          className={cn("space-y-1", ordered && "list-decimal pl-5")}
          {...(ordered ? { start } : {})}
        >
          {tasks.map((task) => (
            <li key={task.taskId}>
              <button
                type="button"
                className="flex w-full justify-between gap-2 rounded px-1 py-0.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onFocus(taskKey(task.taskId))}
              >
                <span>{task.title}</span>
                {showPriority && (
                  <span className="shrink-0 text-xs text-subtle tabular-nums">
                    P{task.priority}
                  </span>
                )}
              </button>
            </li>
          ))}
        </List>
      )}
    </section>
  );
}

function TaskListPager({
  title,
  page,
  totalPages,
  onPageChange,
}: {
  title: string;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div
      role="group"
      aria-label={`${title} pages`}
      className="flex items-center justify-between gap-2 text-xs"
    >
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={page === 0}
        onClick={() => onPageChange(page - 1)}
      >
        Previous
      </Button>
      <span className="tabular-nums">
        Page {page + 1} of {totalPages.toLocaleString()}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={page === totalPages - 1}
        onClick={() => onPageChange(page + 1)}
      >
        Next
      </Button>
    </div>
  );
}

function PagedTaskList({
  title,
  ids,
  tasksById,
  empty,
  onFocus,
  showPriority = false,
  requestedPage,
  onRequestedPageChange,
}: {
  title: string;
  ids: readonly string[];
  tasksById: ReadonlyMap<string, TaskGraphNode>;
  empty: string;
  onFocus: (key: string) => void;
  showPriority?: boolean;
  requestedPage?: number;
  onRequestedPageChange?: (page: number) => void;
}) {
  const [localPage, setLocalPage] = useState(0);
  const page = chainPage(ids, tasksById, requestedPage ?? localPage);
  return (
    <>
      <TaskList
        title={title}
        empty={empty}
        tasks={page.tasks}
        onFocus={onFocus}
        showPriority={showPriority}
      />
      <TaskListPager
        title={title}
        page={page.page}
        totalPages={page.totalPages}
        onPageChange={onRequestedPageChange ?? setLocalPage}
      />
    </>
  );
}

function TaskPanel({
  projectId,
  task,
  detail,
  detailLoading,
  detailError,
  onRetryDetail,
  tasksById,
  prerequisites,
  dependents,
  lineage: tree,
  milestones,
  focusOnly,
  onFocusOnly,
  onFocus,
  onClear,
}: {
  projectId: string;
  task: TaskGraphNode;
  detail: TaskDetail | null;
  detailLoading: boolean;
  detailError: boolean;
  onRetryDetail: () => void;
  tasksById: ReadonlyMap<string, TaskGraphNode>;
  prerequisites: readonly string[];
  dependents: readonly string[];
  lineage: { upstream: ReadonlySet<string>; downstream: ReadonlySet<string> };
  milestones: readonly TaskGraphMilestone[];
  focusOnly: boolean;
  onFocusOnly: (value: boolean) => void;
  onFocus: (key: string) => void;
  onClear: () => void;
}) {
  const unmet = new Set(task.unmetPrerequisiteIds);
  const waitingOn = task.unmetPrerequisiteIds.length;
  return (
    <>
      <div className="space-y-2">
        <h3 className="text-base font-semibold leading-snug">{task.title}</h3>
        <p
          className="break-all font-mono text-xs text-subtle"
          title={task.taskId}
        >
          {task.taskId}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge
            label={statusLabel(task.operationalStatus)}
            tone={taskStatusTone(task.operationalStatus)}
          />
          <span className="text-xs text-subtle tabular-nums">
            recorded {task.recordedStatus.replaceAll("_", " ")} · P
            {task.priority}
          </span>
        </div>
        <p className="text-xs">
          {task.ready
            ? "Ready: its status allows work and every prerequisite is completed."
            : task.waiting
              ? `Waiting on ${blockers(waitingOn)}.`
              : `${idleState(task)}.`}
        </p>
        {task.assignedAgent !== null && (
          <p className="text-xs text-subtle">
            Agent: {task.assignedAgent.name}
          </p>
        )}
        {milestones.length > 0 && (
          <p className="text-xs text-subtle">
            Milestones: {milestones.map((m) => m.title).join(", ")}
          </p>
        )}
        <p className="text-xs text-subtle tabular-nums">
          {tree.upstream.size} upstream · {tree.downstream.size} downstream
          (transitive)
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link
              to={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.taskId)}`}
            >
              Open task
            </Link>
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onClear}>
            Clear
          </Button>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={focusOnly}
            onChange={(event) => onFocusOnly(event.target.checked)}
          />
          Only this lineage
        </label>
      </div>
      {detailLoading ? (
        <p role="status" className="text-xs text-subtle">
          Loading task and requirement details…
        </p>
      ) : detailError ? (
        <div role="alert" className="space-y-2 text-xs">
          <p>Task and requirement details could not be loaded.</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRetryDetail}
          >
            Retry
          </Button>
        </div>
      ) : detail !== null ? (
        <GraphTaskDetailSections task={detail.task} />
      ) : null}
      {task.waiting ? (
        <PagedTaskList
          title="Waiting on"
          empty="No unfinished prerequisites."
          ids={task.unmetPrerequisiteIds}
          tasksById={tasksById}
          onFocus={onFocus}
        />
      ) : (
        task.unmetPrerequisiteIds.length > 0 && (
          // A finished task is not waiting, but the record stays honest.
          <PagedTaskList
            title="Prerequisites never completed"
            empty=""
            ids={task.unmetPrerequisiteIds}
            tasksById={tasksById}
            onFocus={onFocus}
          />
        )
      )}
      {!task.terminal && (
        <PagedTaskList
          title="Unblocks when completed"
          empty="Completing it makes no other task ready on its own."
          ids={task.completionUnblocks}
          tasksById={tasksById}
          showPriority
          onFocus={onFocus}
        />
      )}
      <PagedTaskList
        title="Other dependents"
        empty="None."
        ids={otherDependentIds(dependents, task.completionUnblocks)}
        tasksById={tasksById}
        onFocus={onFocus}
      />
      <PagedTaskList
        title="Completed prerequisites"
        empty="None."
        ids={prerequisites.filter((id) => !unmet.has(id))}
        tasksById={tasksById}
        onFocus={onFocus}
      />
    </>
  );
}

export function GraphTaskDetailSections({
  task,
}: {
  task: Pick<
    TaskOperationalState,
    "description" | "requirements" | "requirementReferences"
  >;
}) {
  const [visibleRequirements, setVisibleRequirements] = useState(8);
  const references = task.requirementReferences ?? [];
  return (
    <>
      <section
        aria-label="Task details"
        className="space-y-2 border-t border-border pt-3"
      >
        <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">
          Task details
        </h4>
        <p className="whitespace-pre-wrap break-words text-xs">
          {task.description?.trim() || "No description recorded."}
        </p>
      </section>
      <section
        aria-label="Linked requirements"
        className="space-y-2 border-t border-border pt-3"
      >
        <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">
          Requirements
        </h4>
        {task.requirements.availability === "unavailable" ? (
          <p className="text-xs text-subtle">{task.requirements.explanation}</p>
        ) : (
          <>
            <p className="text-xs text-subtle">
              {task.requirements.value.verified} of{" "}
              {task.requirements.value.total} verified
            </p>
            {references.length === 0 ? (
              <p className="text-xs text-subtle">
                {task.requirements.value.total === 0
                  ? "No requirements linked."
                  : "Linked requirement details are unavailable."}
              </p>
            ) : (
              <>
                <ul className="space-y-3">
                  {references
                    .slice(0, visibleRequirements)
                    .map((requirement) => (
                      <li
                        key={requirement.requirementId}
                        className="space-y-1 rounded border border-border p-2"
                      >
                        <p className="break-words text-xs font-medium">
                          <span className="font-mono text-subtle">
                            {requirement.key}
                          </span>{" "}
                          {requirement.title}
                        </p>
                        <StatusBadge
                          label={requirement.status}
                          tone={requirementStatusTone(requirement.status)}
                        />
                        <p className="whitespace-pre-wrap break-words text-xs text-subtle">
                          {requirement.description.trim() ||
                            "No description recorded."}
                        </p>
                      </li>
                    ))}
                </ul>
                {references.length > visibleRequirements && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setVisibleRequirements((count) => count + 8)}
                  >
                    Show more requirements (
                    {references.length - visibleRequirements} remaining)
                  </Button>
                )}
              </>
            )}
          </>
        )}
      </section>
    </>
  );
}

function Legend() {
  const swatch = (hex: string, dashed = false, thick = false) => (
    <span
      aria-hidden="true"
      className="inline-block w-6 align-middle"
      style={{
        borderTop: `${thick ? 4 : 2}px ${dashed ? "dashed" : "solid"} ${hex}`,
      }}
    />
  );
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">
        Legend
      </h3>
      <ul className="space-y-1 text-xs text-subtle">
        <li>{swatch(colour.unmet, true)} dashed: prerequisite not completed</li>
        <li>{swatch(colour.neutral)} faint: prerequisite completed</li>
        <li>{swatch(colour.chain, false, true)} thick red: longest chain</li>
        <li>
          {swatch(colour.lineage, false, true)} thick blue: selected lineage
        </li>
        <li>Arrows point from a prerequisite to the task that needs it.</li>
        <li>Milestones appear as a label on each task.</li>
      </ul>
    </section>
  );
}
