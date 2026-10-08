import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { TaskGraphNode } from "@ai-office/application/read-models/operational-read-models.ts";
import {
  GraphTaskDetailSections,
  Legend,
  OverviewTaskLists,
  TaskPanel,
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
    unmetPrerequisiteIds: [],
    ready: true,
    waiting: false,
    needsAttention: false,
    completionUnblocks: [],
    terminal: false,
  };
}

describe("graph overview task lists", () => {
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
          focusOnly: false,
          onFocusOnly: () => {},
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
    expect(html).toContain("prerequisite not completed or in review");
    expect(html).toContain("prerequisite completed or in review");
  });
});
