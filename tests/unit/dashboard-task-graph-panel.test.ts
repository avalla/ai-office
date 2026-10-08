import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  TaskGraph,
  TaskGraphNode,
} from "@ai-office/application/read-models/operational-read-models.ts";
import {
  GraphTaskDetailSections,
  OverviewTaskLists,
  TaskGraphView,
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
