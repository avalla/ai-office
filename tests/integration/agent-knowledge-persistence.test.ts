import { describe, expect, it } from "vitest";
import { connectSurrealAgentKnowledgeStore } from "../../packages/storage-surrealdb/src/connect-agent-knowledge-store.ts";

// Run seed, restart the persistent SurrealDB process, then run verify in a
// separate test process. The dedicated CI job owns that process boundary.
const endpoint = process.env.AI_OFFICE_TEST_SURREALDB_PERSISTENCE_URL;
const phase = process.env.AI_OFFICE_TEST_SURREALDB_PERSISTENCE_PHASE;
const scope = { tenantId: "ak09-tenant-a", repositoryId: "ak09-repository-a" };
const otherRepository = { ...scope, repositoryId: "ak09-repository-b" };
const otherTenant = {
  tenantId: "ak09-tenant-b",
  repositoryId: scope.repositoryId,
};
const input = {
  ...scope,
  id: "ak09-restart-memory",
  text: "Persistent knowledge survives a SurrealDB restart",
  agentId: "ak09-agent",
  runId: "ak09-run",
  taskId: "ak09-task",
  source: {
    id: "ak09-source",
    kind: "requirement" as const,
    label: "AK-09 persistence",
    locator: "requirements/AK-09",
  },
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
};

async function withStore(
  check: (
    store: Awaited<
      ReturnType<typeof connectSurrealAgentKnowledgeStore>
    >["store"],
  ) => Promise<void>,
): Promise<void> {
  const connected = await connectSurrealAgentKnowledgeStore({
    endpoint: endpoint!,
    namespace: "ai_office_ak09",
    database: "persistent_knowledge",
    username: "root",
    password: "root",
  });
  try {
    await check(connected.store);
  } finally {
    await connected.close();
  }
}

describe.skipIf(endpoint === undefined)(
  "persistent SurrealDB Agent Knowledge",
  () => {
    it.skipIf(phase !== "seed")(
      "writes scoped knowledge and provenance before shutdown",
      async () => {
        await withStore(async (store) => {
          await store.recordMemory(input);
          expect(
            await store.traceMemoryProvenance(scope, input.id),
          ).toMatchObject({
            runId: input.runId,
            taskId: input.taskId,
            agentId: input.agentId,
            source: input.source,
          });
        });
      },
    );

    it.skipIf(phase !== "verify")(
      "recovers the same knowledge after process restart without crossing scope",
      async () => {
        await withStore(async (store) => {
          expect(
            await store.traceMemoryProvenance(scope, input.id),
          ).toMatchObject({
            knowledge: { id: input.id, text: input.text, ...scope },
            runId: input.runId,
            taskId: input.taskId,
            agentId: input.agentId,
            source: input.source,
          });
          expect(
            await store.findKnowledge(scope, { text: "Persistent knowledge" }),
          ).toMatchObject([{ id: input.id, ...scope }]);
          expect(
            await store.findKnowledge(otherRepository, {
              text: "Persistent knowledge",
            }),
          ).toEqual([]);
          expect(
            await store.findKnowledge(otherTenant, {
              text: "Persistent knowledge",
            }),
          ).toEqual([]);
          expect(
            await store.traceMemoryProvenance(otherRepository, input.id),
          ).toBeNull();
          expect(
            await store.traceMemoryProvenance(otherTenant, input.id),
          ).toBeNull();
        });
      },
    );
  },
);
