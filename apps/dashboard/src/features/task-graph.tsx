import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { terminalTaskOperationalStatuses } from "@ai-office/application/read-models/operational-read-models.ts";
import type {
  TaskGraph,
  TaskGraphMilestone,
  TaskGraphNode,
  TaskOperationalStatus,
} from "@ai-office/application/read-models/operational-read-models.ts";
import { Empty, Section, StatusBadge } from "../components/operations.tsx";
import { Button, Input, Select, cn } from "../components/ui/primitives.tsx";
import {
  defaultGraphFilters,
  filterGraph,
  layoutGraph,
  lineage,
  milestoneKey,
  milestoneNodeSize,
  nodeSize,
  taskKey,
  type GraphDirection,
  type GraphFilters,
} from "../lib/task-graph.ts";
import {
  milestoneStatusTone,
  taskStatusTone,
  type ToneName,
} from "../ui/view-model.ts";

/* -------------------------------------------------------------------------- */
/* Colours (fixed so SVG markers render the same in light and dark mode)       */
/* -------------------------------------------------------------------------- */

const colour = {
  edge: "#8b95a7",
  blocking: "#d97706",
  satisfied: "#10b981",
  focus: "#2563eb",
  critical: "#dc2626",
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

const statusLabel = (status: TaskOperationalStatus) =>
  status.replaceAll("_", " ");

/* -------------------------------------------------------------------------- */
/* Nodes                                                                       */
/* -------------------------------------------------------------------------- */

interface TaskNodeData extends Record<string, unknown> {
  task: TaskGraphNode;
  dimmed: boolean;
  selected: boolean;
  critical: boolean;
  direction: GraphDirection;
  onSelect: (key: string) => void;
}

interface MilestoneNodeData extends Record<string, unknown> {
  milestone: TaskGraphMilestone;
  memberCount: number;
  dimmed: boolean;
  selected: boolean;
  direction: GraphDirection;
  onSelect: (key: string) => void;
}

type TaskFlowNode = Node<TaskNodeData, "task">;
type MilestoneFlowNode = Node<MilestoneNodeData, "milestone">;

function handles(direction: GraphDirection) {
  return {
    target: direction === "LR" ? Position.Left : Position.Top,
    source: direction === "LR" ? Position.Right : Position.Bottom,
  };
}

const hiddenHandle = "!h-1 !w-1 !border-0 !bg-transparent !min-h-0 !min-w-0";

function TaskNodeView({ data }: NodeProps<TaskFlowNode>) {
  const { task } = data;
  const sides = handles(data.direction);
  const waiting = task.unmetPrerequisiteIds.length;
  return (
    <>
      <Handle
        type="target"
        position={sides.target}
        className={hiddenHandle}
        isConnectable={false}
      />
      <button
        type="button"
        aria-pressed={data.selected}
        aria-label={`${task.title}. ${statusLabel(task.operationalStatus)}. ${
          task.ready
            ? "Runnable"
            : waiting > 0
              ? `Waiting on ${waiting} prerequisite${waiting === 1 ? "" : "s"}`
              : "Not startable"
        }.`}
        onClick={() => data.onSelect(taskKey(task.taskId))}
        style={{ width: nodeSize.width, height: nodeSize.height }}
        className={cn(
          "flex flex-col justify-between rounded-lg border bg-surface px-3 py-2 text-left shadow-sm transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          data.selected
            ? "border-primary ring-2 ring-primary"
            : data.critical
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
          <span className="flex items-center gap-1.5 text-xs text-subtle tabular-nums">
            {task.ready && (
              <span className="rounded border border-emerald-300 px-1 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300">
                runnable
              </span>
            )}
            {waiting > 0 && (
              <span
                title={`${waiting} unmet prerequisite${waiting === 1 ? "" : "s"}`}
                className="rounded border border-amber-400 px-1 text-amber-800 dark:text-amber-300"
              >
                ⧗ {waiting}
              </span>
            )}
            <span title="Priority">P{task.priority}</span>
          </span>
        </span>
      </button>
      <Handle
        type="source"
        position={sides.source}
        className={hiddenHandle}
        isConnectable={false}
      />
    </>
  );
}

function MilestoneNodeView({ data }: NodeProps<MilestoneFlowNode>) {
  const { milestone } = data;
  const sides = handles(data.direction);
  const { verified, total } = milestone.requirements;
  return (
    <>
      <Handle
        type="target"
        position={sides.target}
        className={hiddenHandle}
        isConnectable={false}
      />
      <button
        type="button"
        aria-pressed={data.selected}
        aria-label={`Milestone ${milestone.title}. ${milestone.status}. ${verified} of ${total} requirements verified. ${data.memberCount} visible tasks.`}
        onClick={() => data.onSelect(milestoneKey(milestone.milestoneId))}
        style={{ width: milestoneNodeSize.width }}
        className={cn(
          "flex flex-col gap-1 rounded-lg border-2 border-dashed bg-muted px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          data.selected ? "border-primary" : "border-subtle",
          data.dimmed && "opacity-25",
        )}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold">
            ◆ {milestone.title}
          </span>
          <StatusBadge
            label={milestone.status}
            tone={milestoneStatusTone(milestone.status)}
          />
        </span>
        <span className="text-xs text-subtle tabular-nums">
          {verified}/{total} requirements verified · {data.memberCount} tasks
        </span>
      </button>
      <Handle
        type="source"
        position={sides.source}
        className={hiddenHandle}
        isConnectable={false}
      />
    </>
  );
}

const nodeTypes = { task: TaskNodeView, milestone: MilestoneNodeView };

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

const readableZoom = 0.55;

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
    <ReactFlowProvider>
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
  const [direction, setDirection] = useState<GraphDirection>("LR");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focusOnly, setFocusOnly] = useState(false);
  const [showCritical, setShowCritical] = useState(true);
  const { fitView, setViewport } = useReactFlow();

  const patch = (change: Partial<GraphFilters>) =>
    setFilters((current) => ({ ...current, ...change }));

  const tasksById = useMemo(
    () => new Map(graph.tasks.map((task) => [task.taskId, task])),
    [graph.tasks],
  );
  const milestonesById = useMemo(
    () => new Map(graph.milestones.map((m) => [m.milestoneId, m])),
    [graph.milestones],
  );

  // A live refresh can remove the selected item; never keep a dangling one.
  const selectedTask =
    selectedKey?.startsWith("t:") === true
      ? (tasksById.get(selectedKey.slice(2)) ?? null)
      : null;
  const selectedMilestone =
    selectedKey?.startsWith("m:") === true
      ? (milestonesById.get(selectedKey.slice(2)) ?? null)
      : null;

  const selectedLineage = useMemo(
    () =>
      selectedTask === null ? null : lineage(graph.edges, selectedTask.taskId),
    [graph.edges, selectedTask],
  );
  const related = useMemo(() => {
    if (selectedTask !== null && selectedLineage !== null)
      return new Set([
        selectedTask.taskId,
        ...selectedLineage.upstream,
        ...selectedLineage.downstream,
      ]);
    if (selectedMilestone !== null)
      return new Set(
        graph.tasks
          .filter((t) => t.milestoneIds.includes(selectedMilestone.milestoneId))
          .map((t) => t.taskId),
      );
    return null;
  }, [graph.tasks, selectedLineage, selectedMilestone, selectedTask]);

  const visible = useMemo(
    () =>
      filterGraph(graph, filters, {
        ...(selectedTask === null
          ? {}
          : { keep: new Set([selectedTask.taskId]) }),
        ...(focusOnly && related !== null ? { only: related } : {}),
      }),
    [filters, focusOnly, graph, related, selectedTask],
  );

  const positions = useMemo(
    () => layoutGraph(visible, direction),
    [visible, direction],
  );

  const criticalIds = useMemo(
    () => new Set(showCritical ? graph.criticalPath : []),
    [graph.criticalPath, showCritical],
  );
  const criticalEdges = useMemo(() => {
    const pairs = new Set<string>();
    if (!showCritical) return pairs;
    for (let i = 1; i < graph.criticalPath.length; i += 1)
      pairs.add(`${graph.criticalPath[i - 1]}>${graph.criticalPath[i]}`);
    return pairs;
  }, [graph.criticalPath, showCritical]);

  const memberCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of visible.membership)
      counts.set(link.milestoneId, (counts.get(link.milestoneId) ?? 0) + 1);
    return counts;
  }, [visible.membership]);

  const select = useCallback(
    (key: string) =>
      setSelectedKey((current) => (current === key ? null : key)),
    [],
  );

  const nodes = useMemo<(TaskFlowNode | MilestoneFlowNode)[]>(() => {
    const result: (TaskFlowNode | MilestoneFlowNode)[] = [];
    for (const task of visible.tasks) {
      const position = positions.get(taskKey(task.taskId));
      if (position === undefined) continue;
      result.push({
        id: taskKey(task.taskId),
        type: "task",
        position,
        width: nodeSize.width,
        height: nodeSize.height,
        draggable: false,
        connectable: false,
        focusable: false,
        data: {
          task,
          direction,
          selected: selectedKey === taskKey(task.taskId),
          critical: criticalIds.has(task.taskId),
          dimmed: related !== null && !related.has(task.taskId),
          onSelect: select,
        },
      });
    }
    for (const milestone of visible.milestones) {
      const position = positions.get(milestoneKey(milestone.milestoneId));
      if (position === undefined) continue;
      const members = new Set(
        graph.tasks
          .filter((t) => t.milestoneIds.includes(milestone.milestoneId))
          .map((t) => t.taskId),
      );
      result.push({
        id: milestoneKey(milestone.milestoneId),
        type: "milestone",
        position,
        width: milestoneNodeSize.width,
        height: milestoneNodeSize.height,
        draggable: false,
        connectable: false,
        focusable: false,
        data: {
          milestone,
          direction,
          memberCount: memberCount.get(milestone.milestoneId) ?? 0,
          selected: selectedKey === milestoneKey(milestone.milestoneId),
          dimmed:
            related !== null &&
            selectedMilestone?.milestoneId !== milestone.milestoneId &&
            ![...members].some((id) => related.has(id)) &&
            selectedTask === null,
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
    criticalIds,
    direction,
    graph.tasks,
    memberCount,
    positions,
    related,
    select,
    selectedKey,
    selectedMilestone,
    selectedTask,
    visible.milestones,
    visible.tasks,
  ]);

  const edges = useMemo<Edge[]>(() => {
    const result: Edge[] = [];
    const lineageScope =
      selectedTask !== null && selectedLineage !== null
        ? {
            up: new Set([selectedTask.taskId, ...selectedLineage.upstream]),
            down: new Set([selectedTask.taskId, ...selectedLineage.downstream]),
          }
        : null;
    for (const edge of visible.edges) {
      const prerequisite = tasksById.get(edge.dependsOnTaskId);
      const blocking = prerequisite?.recordedStatus !== "completed";
      const onLineage =
        lineageScope !== null &&
        ((lineageScope.up.has(edge.taskId) &&
          lineageScope.up.has(edge.dependsOnTaskId)) ||
          (lineageScope.down.has(edge.taskId) &&
            lineageScope.down.has(edge.dependsOnTaskId)));
      const critical = criticalEdges.has(
        `${edge.dependsOnTaskId}>${edge.taskId}`,
      );
      const stroke = onLineage
        ? colour.focus
        : critical
          ? colour.critical
          : blocking
            ? colour.blocking
            : colour.satisfied;
      result.push({
        id: `d:${edge.dependsOnTaskId}>${edge.taskId}`,
        source: taskKey(edge.dependsOnTaskId),
        target: taskKey(edge.taskId),
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        style: {
          stroke,
          strokeWidth: onLineage || critical ? 3 : 1.5,
          opacity: lineageScope !== null && !onLineage ? 0.12 : 1,
        },
      });
    }
    for (const link of visible.membership) {
      const dim =
        (related !== null && selectedTask !== null) ||
        (selectedMilestone !== null &&
          selectedMilestone.milestoneId !== link.milestoneId);
      result.push({
        id: `m:${link.taskId}>${link.milestoneId}`,
        source: taskKey(link.taskId),
        target: milestoneKey(link.milestoneId),
        type: "default",
        style: {
          stroke: colour.edge,
          strokeDasharray: "4 4",
          strokeWidth: 1,
          opacity: dim ? 0.08 : 0.7,
        },
      });
    }
    return result;
  }, [
    criticalEdges,
    related,
    selectedLineage,
    selectedMilestone,
    selectedTask,
    tasksById,
    visible.edges,
    visible.membership,
  ]);

  // Re-frame only when the layout itself changes, never on selection or on a
  // live refresh that leaves the visible set untouched.
  // Keyed on what the user chose and on the project's structure (its tasks and
  // dependencies), not on task state: a refresh that completes a task, or a
  // focus jump, keeps the viewport, while new tasks or links re-frame it.
  const structure = useMemo(
    () =>
      `${graph.tasks.length}|${graph.edges
        .map((edge) => `${edge.dependsOnTaskId}>${edge.taskId}`)
        .join(",")}`,
    [graph.edges, graph.tasks.length],
  );
  const layoutSignature = `${direction}|${focusOnly}|${JSON.stringify(filters)}|${structure}`;
  // Isolation belongs to a selection; do not carry it into the next one.
  useEffect(() => {
    if (related === null) setFocusOnly(false);
  }, [related]);

  const canvasRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    const handle = requestAnimationFrame(() => frameRef.current());
    return () => cancelAnimationFrame(handle);
  }, [layoutSignature]);

  const focusOn = useCallback(
    (key: string) => {
      setSelectedKey(key);
      requestAnimationFrame(() =>
        fitView({
          nodes: [{ id: key }],
          maxZoom: 1.1,
          padding: 0.6,
          duration: prefersReducedMotion() ? 0 : 250,
        }),
      );
    },
    [fitView],
  );

  const readyTasks = useMemo(
    () =>
      visible.tasks
        .filter((t) => t.ready)
        .sort(
          (a, b) => b.priority - a.priority || a.taskId.localeCompare(b.taskId),
        ),
    [visible.tasks],
  );

  const totals = {
    ready: graph.tasks.filter((t) => t.ready).length,
    waiting: graph.tasks.filter(
      (t) =>
        t.unmetPrerequisiteIds.length > 0 &&
        !terminalTaskOperationalStatuses.includes(t.operationalStatus),
    ).length,
  };

  const filtered =
    filters.search !== "" ||
    filters.status !== "" ||
    filters.milestone !== "" ||
    filters.readyOnly ||
    !filters.hideCompleted ||
    !filters.showMilestones;

  if (graph.tasks.length === 0)
    return (
      <Section title="Dependency graph">
        <Empty>This project has no tasks yet.</Empty>
      </Section>
    );

  return (
    <Section
      title="Dependency graph"
      detail={`${visible.tasks.length} of ${graph.tasks.length} tasks · ${visible.edges.length} of ${graph.edges.length} dependencies`}
    >
      <form
        className="flex flex-wrap items-end gap-3"
        role="search"
        aria-label="Graph filters"
        onSubmit={(event) => event.preventDefault()}
      >
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-subtle">
          Search tasks
          <Input
            type="search"
            value={filters.search}
            placeholder="Title or id"
            onChange={(event) => patch({ search: event.target.value })}
          />
        </label>
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
        <div
          role="group"
          aria-label="Layout direction"
          className="flex flex-col gap-1 text-xs text-subtle"
        >
          Layout
          <div className="flex gap-1">
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
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        {(
          [
            [
              "Runnable only",
              filters.readyOnly,
              (v: boolean) => patch({ readyOnly: v }),
            ],
            [
              "Hide completed",
              filters.hideCompleted,
              (v: boolean) => patch({ hideCompleted: v }),
            ],
            [
              "Milestones",
              filters.showMilestones,
              (v: boolean) => patch({ showMilestones: v }),
            ],
            ["Critical path", showCritical, setShowCritical],
          ] as const
        ).map(([label, checked, set]) => (
          <label key={label} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => set(event.target.checked)}
            />
            {label}
          </label>
        ))}
        {related !== null && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={focusOnly}
              onChange={(event) => setFocusOnly(event.target.checked)}
            />
            Only the selection&rsquo;s{" "}
            {selectedTask === null ? "tasks" : "lineage"}
          </label>
        )}
        {filtered && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setFilters(defaultGraphFilters)}
          >
            Reset filters
          </Button>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div
          ref={canvasRef}
          className="h-[70vh] min-h-[26rem] overflow-hidden rounded-xl border border-border bg-surface"
          onKeyDown={(event) => {
            if (event.key === "Escape") setSelectedKey(null);
          }}
        >
          {visible.tasks.length === 0 ? (
            <div className="p-6">
              <Empty>No tasks match these filters.</Empty>
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
              onPaneClick={() => setSelectedKey(null)}
              proOptions={{ hideAttribution: true }}
              aria-label="Task dependency graph. The side panel lists give keyboard access to runnable, critical-path and related tasks."
            >
              <Background gap={24} />
              <Controls showInteractive={false} />
              <MiniMap
                className="!hidden sm:!block"
                pannable
                zoomable
                nodeColor={(node) =>
                  node.type === "task"
                    ? miniMapColour[
                        taskStatusTone(
                          (node.data as TaskNodeData).task.operationalStatus,
                        )
                      ]
                    : colour.edge
                }
                bgColor="hsl(var(--surface))"
                maskColor="rgba(120,130,150,0.18)"
              />
            </ReactFlow>
          )}
        </div>

        <aside
          aria-label="Graph details"
          className="flex max-h-[70vh] min-h-0 flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-surface p-4 text-sm"
        >
          {selectedTask !== null && selectedLineage !== null ? (
            <TaskPanel
              projectId={projectId}
              task={selectedTask}
              tasksById={tasksById}
              dependents={graph.edges
                .filter((e) => e.dependsOnTaskId === selectedTask.taskId)
                .map((e) => e.taskId)}
              lineage={selectedLineage}
              milestones={selectedTask.milestoneIds.flatMap((id) => {
                const m = milestonesById.get(id);
                return m === undefined ? [] : [m];
              })}
              onFocus={focusOn}
              onClear={() => setSelectedKey(null)}
            />
          ) : selectedMilestone !== null ? (
            <MilestonePanel
              milestone={selectedMilestone}
              tasks={graph.tasks.filter((t) =>
                t.milestoneIds.includes(selectedMilestone.milestoneId),
              )}
              onFocus={focusOn}
              onClear={() => setSelectedKey(null)}
            />
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-3">
                <Fact label="Runnable now" value={totals.ready} />
                <Fact label="Waiting on prerequisites" value={totals.waiting} />
                <Fact label="Dependencies" value={graph.edges.length} />
                <Fact label="Critical path" value={graph.criticalPath.length} />
              </dl>
              <TaskList
                title="Runnable now"
                empty="Nothing visible is runnable."
                tasks={readyTasks.slice(0, 10)}
                onFocus={focusOn}
                note={
                  readyTasks.length > 10
                    ? `${readyTasks.length - 10} more; narrow the filters to see them.`
                    : undefined
                }
              />
              <TaskList
                title="Critical path"
                empty="No chain of unfinished dependent tasks."
                tasks={graph.criticalPath.flatMap((id) => {
                  const t = tasksById.get(id);
                  return t === undefined ? [] : [t];
                })}
                ordered
                onFocus={focusOn}
              />
              <Legend />
            </>
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

function Fact({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function TaskList({
  title,
  tasks,
  empty,
  onFocus,
  ordered = false,
  note,
}: {
  title: string;
  tasks: readonly TaskGraphNode[];
  empty: string;
  onFocus: (key: string) => void;
  ordered?: boolean;
  note?: string | undefined;
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
        <List className={cn("space-y-1", ordered && "list-decimal pl-5")}>
          {tasks.map((task) => (
            <li key={task.taskId}>
              <button
                type="button"
                className="w-full rounded px-1 py-0.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onFocus(taskKey(task.taskId))}
              >
                {task.title}
              </button>
            </li>
          ))}
        </List>
      )}
      {note !== undefined && <p className="mt-1 text-xs text-subtle">{note}</p>}
    </section>
  );
}

function TaskPanel({
  projectId,
  task,
  tasksById,
  dependents,
  lineage: tree,
  milestones,
  onFocus,
  onClear,
}: {
  projectId: string;
  task: TaskGraphNode;
  tasksById: ReadonlyMap<string, TaskGraphNode>;
  dependents: readonly string[];
  lineage: { upstream: ReadonlySet<string>; downstream: ReadonlySet<string> };
  milestones: readonly TaskGraphMilestone[];
  onFocus: (key: string) => void;
  onClear: () => void;
}) {
  const pick = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const found = tasksById.get(id);
      return found === undefined ? [] : [found];
    });
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
          <span className="text-xs text-subtle">
            recorded {task.recordedStatus.replaceAll("_", " ")} · priority{" "}
            {task.priority}
          </span>
        </div>
        <p className="text-xs">
          {task.ready
            ? "Runnable: its status allows work and every prerequisite is completed."
            : task.unmetPrerequisiteIds.length > 0
              ? `Blocked by ${task.unmetPrerequisiteIds.length} unfinished prerequisite${task.unmetPrerequisiteIds.length === 1 ? "" : "s"}.`
              : "Not startable in its current state."}
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
        <div className="flex gap-2">
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
      </div>
      <TaskList
        title="Waiting on"
        empty="No unfinished prerequisites."
        tasks={pick(task.unmetPrerequisiteIds)}
        onFocus={onFocus}
      />
      <TaskList
        title="Unblocks"
        empty="Nothing depends on this task."
        tasks={pick(dependents)}
        onFocus={onFocus}
      />
    </>
  );
}

function MilestonePanel({
  milestone,
  tasks,
  onFocus,
  onClear,
}: {
  milestone: TaskGraphMilestone;
  tasks: readonly TaskGraphNode[];
  onFocus: (key: string) => void;
  onClear: () => void;
}) {
  return (
    <>
      <div className="space-y-2">
        <h3 className="text-base font-semibold">◆ {milestone.title}</h3>
        <StatusBadge
          label={milestone.status}
          tone={milestoneStatusTone(milestone.status)}
        />
        <p className="text-xs text-subtle tabular-nums">
          {milestone.requirements.verified}/{milestone.requirements.total}{" "}
          requirements verified · {tasks.length} linked tasks
        </p>
        <Button type="button" size="sm" variant="outline" onClick={onClear}>
          Clear
        </Button>
      </div>
      <TaskList
        title="Linked tasks"
        empty="No task is linked to this milestone."
        tasks={tasks}
        onFocus={onFocus}
      />
    </>
  );
}

function Legend() {
  const swatch = (hex: string, dashed = false) => (
    <span
      aria-hidden="true"
      className="inline-block w-6 align-middle"
      style={{ borderTop: `3px ${dashed ? "dashed" : "solid"} ${hex}` }}
    />
  );
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">
        Legend
      </h3>
      <ul className="space-y-1 text-xs text-subtle">
        <li>{swatch(colour.blocking)} prerequisite not completed</li>
        <li>{swatch(colour.satisfied)} prerequisite completed</li>
        <li>{swatch(colour.critical)} critical path</li>
        <li>{swatch(colour.focus)} selected lineage</li>
        <li>{swatch(colour.edge, true)} task belongs to milestone</li>
        <li>Arrows point from a prerequisite to the task that needs it.</li>
      </ul>
    </section>
  );
}
