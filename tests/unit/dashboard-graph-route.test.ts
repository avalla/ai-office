import { expect, test, vi } from "vitest";
import type { TaskGraph } from "@ai-office/application/read-models/operational-read-models.ts";
import {
  getTaskDetail,
  queryRoute,
} from "../../apps/dashboard/src/api/client.ts";
import { parseRoute } from "../../apps/dashboard/src/ui/view-model.ts";

test("graph route reads only the exhaustive graph projection", async () => {
  const graph: TaskGraph = {
    generatedAt: "2026-10-07T10:00:00.000Z",
    projectId: "project-1",
    projectName: "Graph project",
    tasks: [],
    milestones: [],
    edges: [],
    summary: {
      total: 0,
      ready: 0,
      waiting: 0,
      blocked: 0,
      inProgress: 0,
      needsAttention: 0,
    },
    longestDependencyChain: [],
  };
  const requests: string[] = [];
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      requests.push(String(input));
      return Response.json({ graph });
    });
  try {
    expect(await queryRoute(parseRoute("#/projects/project-1/graph"))).toEqual({
      kind: "graph",
      graph,
    });
    expect(requests).toEqual(["/api/projects/project-1/graph"]);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("selected graph task reads its scoped detail with an abort signal", async () => {
  const detail = { task: { taskId: "task/1", description: "Task details" } };
  const controller = new AbortController();
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_input, _init) => Response.json(detail));
  try {
    expect(
      await getTaskDetail("project/1", "task/1", controller.signal),
    ).toEqual(detail.task);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/project%2F1/tasks/task%2F1",
      expect.objectContaining({ signal: controller.signal }),
    );
  } finally {
    fetchSpy.mockRestore();
  }
});
