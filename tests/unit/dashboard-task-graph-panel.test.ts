import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskGraphNode } from "@ai-office/application/read-models/operational-read-models.ts";
import {
  GraphTaskNodeButton,
  GraphTaskDetailSections,
  OverviewTaskLists,
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
  expect(name).toContain("Current milestone");
  for (const html of [full, medium, compact]) {
    expect(html).toContain(`aria-label="${name}"`);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("ring-2 ring-primary");
    expect(html).toContain('style="width:264px;height:96px"');
  }
  // Remove the full accessible name to inspect only the visible tier content.
  const visible = (html: string) => html.replace(/aria-label="[^"]+"/, "");
  expect(visible(full)).toContain("Current milestone");
  expect(visible(full)).toContain("P3");
  expect(visible(medium)).toContain("2 blockers");
  expect(visible(medium)).not.toContain("Current milestone");
  expect(visible(medium)).not.toContain("P3");
  expect(visible(compact)).toContain("not started");
  expect(visible(compact)).not.toContain("2 blockers");
  expect(visible(compact)).not.toContain("Current milestone");
});

test("shipped dashboard CSS includes the compact node utilities", () => {
  const styles = readFileSync(
    new URL("../../apps/dashboard/src/assets/styles.css", import.meta.url),
    "utf8",
  );
  for (const selector of [
    ".h-11{",
    ".w-40{",
    ".text-center{",
    ".text-\\[10px\\]{",
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
