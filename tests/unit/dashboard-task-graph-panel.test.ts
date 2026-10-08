import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type {
  TaskGraph,
  TaskGraphNode,
} from "@ai-office/application/read-models/operational-read-models.ts";
import {
  CompletedPrerequisiteCue,
  GraphTaskNodeButton,
  GraphTaskDetailSections,
  Legend,
  OverviewTaskLists,
  TaskGraphView,
  TaskPanel,
  milestoneGapNotes,
} from "../../apps/dashboard/src/features/task-graph.tsx";

function node(id: string): TaskGraphNode {
  return {
    taskId: id,
    title: `Title ${id}`,
    priority: 0,
    recordedStatus: "pending",
    operationalStatus: "not_started",
    assignedAgent: null,
    milestoneIds: [],
    milestoneGap: "no_requirement",
    unmetPrerequisiteIds: [],
    ready: true,
    waiting: false,
    needsAttention: false,
    completionUnblocks: [],
    terminal: false,
  };
}

describe("graph overview task lists", () => {
  test("labels the graph status filter as operational without changing its value", () => {
    const graph: TaskGraph = {
      generatedAt: "2026-10-07T10:00:00.000Z",
      projectId: "p",
      projectName: "P",
      tasks: [node("a")],
      milestones: [],
      edges: [],
      summary: {
        total: 1,
        ready: 1,
        waiting: 0,
        blocked: 0,
        inProgress: 0,
        needsAttention: 0,
      },
      longestDependencyChain: [],
    };
    const markup = renderToStaticMarkup(
      createElement(TaskGraphView, { graph, projectId: "p" }),
    );
    expect(markup).toMatch(/Operational status.*?<select/s);
    expect(markup).toContain(
      '<option value="failed">Failed (operational)</option>',
    );
    expect(markup).toContain('<option value="completed">completed</option>');
  });
  test("keeps chain positions across pages", () => {
    const chain = Array.from({ length: 30 }, (_, i) => node(`c${i}`));
    const html = renderToStaticMarkup(
      createElement(OverviewTaskLists, {
        readyTasks: [],
        attentionTasks: [],
        chainIds: chain.map((task) => task.taskId),
        tasksById: new Map(chain.map((task) => [task.taskId, task])),
        readyPageIndex: 0,
        attentionPageIndex: 0,
        chainPageIndex: 1,
        onReadyPageChange: () => {},
        onAttentionPageChange: () => {},
        onChainPageChange: () => {},
        onFocus: () => {},
      }),
    );
    expect(html).toMatch(/<ol[^>]*start="26"/);
    expect(html).toContain("Title c25");
    expect(html).not.toContain("Title c24");
  });

  test("ready and attention tasks remain browsable beyond the first eight", () => {
    const readyTasks = Array.from({ length: 30 }, (_, i) => node(`r${i}`));
    const attentionTasks = Array.from({ length: 30 }, (_, i) => node(`a${i}`));
    const tasksById = new Map(
      [...readyTasks, ...attentionTasks].map((task) => [task.taskId, task]),
    );
    const html = renderToStaticMarkup(
      createElement(OverviewTaskLists, {
        readyTasks,
        attentionTasks,
        chainIds: [],
        tasksById,
        readyPageIndex: 0,
        attentionPageIndex: 0,
        chainPageIndex: 0,
        onReadyPageChange: () => {},
        onAttentionPageChange: () => {},
        onChainPageChange: () => {},
        onFocus: () => {},
      }),
    );

    expect(html).toContain('aria-label="Ready to start pages"');
    expect(html).toContain('aria-label="Needs attention pages"');
    expect(html).toContain("Title r24");
    expect(html).toContain("Title a24");
    expect(html).not.toContain("Title r25");
    expect(html).not.toContain("Title a25");

    const laterPage = renderToStaticMarkup(
      createElement(OverviewTaskLists, {
        readyTasks,
        attentionTasks,
        chainIds: [],
        tasksById,
        readyPageIndex: 1,
        attentionPageIndex: 1,
        chainPageIndex: 0,
        onReadyPageChange: () => {},
        onAttentionPageChange: () => {},
        onChainPageChange: () => {},
        onFocus: () => {},
      }),
    );
    expect(laterPage).toContain("Title r25");
    expect(laterPage).toContain("Title a25");
    expect(laterPage).not.toContain("Title r0");
    expect(laterPage).not.toContain("Title a0");
  });
});

test("graph node tiers preserve accessible identity, selection, and fixed footprint", () => {
  const task = {
    ...node("selected"),
    title: "Selected task with a complete name",
    priority: 3,
    ready: false,
    waiting: true,
    unmetPrerequisiteIds: ["first", "second"],
  };
  const data = {
    task,
    milestone: { title: "Current milestone", more: 0 },
    dimmed: false,
    selected: true,
    onChain: false,
    hiddenCompletedPrerequisites: 2,
    direction: "LR" as const,
    onSelect: () => {},
  };
  const render = (detail: "full" | "medium" | "compact") =>
    renderToStaticMarkup(createElement(GraphTaskNodeButton, { data, detail }));
  const full = render("full");
  const medium = render("medium");
  const compact = render("compact");
  const name = full.match(/aria-label="([^"]+)"/)?.[1];

  expect(name).toContain("Selected task with a complete name");
  expect(name).toContain("2 blockers");
  expect(full).toContain(
    "2 blockers: prerequisites neither completed nor in review",
  );
  expect(name).toContain("Current milestone");
  expect(name).toContain("2 completed prerequisites hidden from graph");
  for (const html of [full, medium, compact]) {
    expect(html).toContain(`aria-label="${name}"`);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("ring-2 ring-primary");
    expect(html).toContain('style="width:264px;height:96px');
  }
  // Remove the full accessible name to inspect only the visible tier content.
  const visible = (html: string) => html.replace(/aria-label="[^"]+"/, "");
  expect(visible(full)).toContain("Current milestone");
  expect(visible(full)).toContain("P3");
  expect(visible(medium)).toContain("2 blockers");
  expect(visible(medium)).not.toContain("Current milestone");
  expect(visible(medium)).not.toContain("P3");
  expect(visible(compact)).toContain("2 blockers");
  expect(visible(compact)).toContain("border-left-color:#f59e0b");
  expect(visible(compact)).not.toContain("Current milestone");
});

test("completed prerequisite cue clears TB edges and dims with its node", () => {
  const render = (
    direction: "LR" | "TB",
    dimmed: boolean,
    detail: "full" | "medium" | "compact",
  ) =>
    renderToStaticMarkup(
      createElement(CompletedPrerequisiteCue, {
        count: 2,
        direction,
        dimmed,
        detail,
      }),
    );
  expect(render("LR", false, "full")).toContain("left-2 top-full mt-1");
  expect(render("TB", false, "medium")).toContain("bottom-full right-2 mb-1");
  expect(render("TB", true, "medium")).toContain("opacity-25");
  expect(render("LR", false, "compact")).toContain("text-base");
  expect(render("LR", false, "compact")).toContain("✓ 2</span>");
  expect(
    renderToStaticMarkup(
      createElement(CompletedPrerequisiteCue, {
        count: 0,
        direction: "TB",
        dimmed: false,
        detail: "full",
      }),
    ),
  ).toBe("");
});

test("compact graph nodes distinguish ready from waiting with text and a stripe", () => {
  const base = {
    milestone: null,
    dimmed: false,
    selected: false,
    onChain: false,
    hiddenCompletedPrerequisites: 0,
    direction: "LR" as const,
    onSelect: () => {},
  };
  const render = (task: TaskGraphNode) =>
    renderToStaticMarkup(
      createElement(GraphTaskNodeButton, {
        data: { ...base, task },
        detail: "compact",
      }),
    );
  const ready = render(node("ready"));
  const waiting = render({
    ...node("waiting"),
    ready: false,
    waiting: true,
    unmetPrerequisiteIds: ["prerequisite"],
  });
  const failedRun = render({
    ...node("retry"),
    operationalStatus: "failed",
    needsAttention: true,
  });
  const failedTask = render({
    ...node("failed"),
    recordedStatus: "failed",
    operationalStatus: "failed",
    terminal: true,
    ready: false,
  });
  const failedWaiting = render({
    ...node("retry-later"),
    operationalStatus: "failed",
    ready: false,
    waiting: true,
    unmetPrerequisiteIds: ["prerequisite"],
  });

  expect(ready).toContain("Ready</span>");
  expect(ready).toContain("border-left-color:#10b981");
  expect(waiting).toContain("1 blocker</span>");
  expect(waiting).toContain("border-left-color:#f59e0b");
  expect(failedRun).toContain("Failed run</span>");
  expect(failedRun).toContain("Ready</span>");
  expect(failedRun).toContain("border-left-color:#f59e0b");
  expect(failedRun).toContain("Ready to start");
  expect(failedTask).toContain("Failed task</span>");
  expect(failedTask).toContain("border-left-color:#f59e0b");
  expect(failedWaiting).toContain("Failed run</span>");
  expect(failedWaiting).toContain("1 blocker</span>");
});

test("shipped dashboard CSS includes the compact node utilities", () => {
  const styles = readFileSync(
    new URL("../../apps/dashboard/src/assets/styles.css", import.meta.url),
    "utf8",
  );
  for (const selector of [
    ".border-l-\\[12px\\]{",
    ".text-xl{",
    ".text-2xl{",
    ".gap-1{",
  ]) {
    expect(styles).toContain(selector);
  }
});

test("selected task panel shows task text and linked requirement details in bounded pages", () => {
  const requirements = Array.from({ length: 9 }, (_, index) => ({
    requirementId: `requirement-${index}`,
    key: `REQ-${index}`,
    title: `Requirement ${index}`,
    description: `Acceptance text ${index}`,
    status: "verified" as const,
    milestoneId: null,
  }));
  const html = renderToStaticMarkup(
    createElement(GraphTaskDetailSections, {
      task: {
        description: "Implement the graph panel",
        requirements: {
          availability: "available",
          value: { total: 9, open: 0, terminal: 9, verified: 9, rejected: 0 },
        },
        requirementReferences: requirements,
      },
    }),
  );

  expect(html).toContain("Implement the graph panel");
  expect(html).toContain("9 of 9 verified");
  expect(html).toContain("REQ-0");
  expect(html).toContain("Acceptance text 0");
  expect(html).toContain("REQ-7");
  expect(html).not.toContain("REQ-8");
  expect(html).toContain("Show more requirements (1 remaining)");
});

describe("task panel prerequisite wording", () => {
  const panel = (
    task: TaskGraphNode,
    others: readonly TaskGraphNode[],
    prerequisites: readonly string[],
  ) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(TaskPanel, {
          projectId: "p",
          task,
          detail: null,
          detailLoading: false,
          detailError: false,
          onRetryDetail: () => {},
          tasksById: new Map([task, ...others].map((t) => [t.taskId, t])),
          prerequisites,
          dependents: [],
          lineage: {
            upstream: new Set<string>(),
            downstream: new Set<string>(),
          },
          milestones: [],
          neighborhoodMode: null,
          onNeighborhoodMode: () => {},
          onFocus: () => {},
          onClear: () => {},
        }),
      ),
    );

  test("separates prerequisites in review from completed ones", () => {
    const reviewed = {
      ...node("rev"),
      recordedStatus: "waiting_review" as const,
    };
    const done = {
      ...node("done"),
      recordedStatus: "completed" as const,
      terminal: true,
    };
    const html = panel(
      { ...node("t"), ready: true },
      [reviewed, done],
      ["rev", "done"],
    );
    expect(html).toContain("every prerequisite is completed or in review.");
    expect(html).toContain("Prerequisites in review");
    expect(html).toContain("Completed prerequisites");
    expect(html.indexOf("Prerequisites in review")).toBeLessThan(
      html.indexOf("Title rev"),
    );
    expect(html.indexOf("Title rev")).toBeLessThan(
      html.indexOf("Completed prerequisites"),
    );
    expect(html.indexOf("Title done")).toBeGreaterThan(
      html.indexOf("Completed prerequisites"),
    );
  });

  test("names review in the unblock and waiting wording", () => {
    const pending = { ...node("pre"), completionUnblocks: ["t"] };
    const html = panel(
      {
        ...node("t"),
        ready: false,
        waiting: true,
        unmetPrerequisiteIds: ["pre"],
      },
      [pending],
      ["pre"],
    );
    expect(html).toContain("Unblocks when in review or completed");
    expect(html).not.toContain("Unblocks when completed");
  });

  test("legend does not equate satisfied with completed", () => {
    const html = renderToStaticMarkup(createElement(Legend));
    expect(html).toContain("prerequisite neither completed nor in review");
    expect(html).toContain("prerequisite completed or in review");
  });
});

describe("milestone gap notes", () => {
  test("give each reason its own remedy and never presume a requirement", () => {
    const task = (id: string, gap: TaskGraphNode["milestoneGap"]) => ({
      ...node(id),
      milestoneGap: gap,
    });
    const notes = milestoneGapNotes([
      task("a", "requirement_without_milestone"),
      task("b", "no_requirement"),
      task("c", "no_requirement"),
      task("d", "no_requirement"),
      task("e", "no_requirement"),
    ]);
    expect(notes.map((note) => note.gap)).toEqual([
      "requirement_without_milestone",
      "no_requirement",
    ]);
    expect(notes[0]!.text).toContain("requirement:assign-milestone");
    expect(notes[0]!.text).toContain("Title a");
    expect(notes[1]!.text).toContain("task:link-requirement");
    expect(notes[1]!.text).not.toContain("assign-milestone");
    // Long lists are clipped.
    expect(notes[1]!.text).toContain("Title b; Title c; Title d; …");
    expect(notes[1]!.text).not.toContain("Title e");
  });
});
