import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskGraphNode } from "@ai-office/application/read-models/operational-read-models.ts";
import { OverviewTaskLists } from "../../apps/dashboard/src/features/task-graph.tsx";

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
