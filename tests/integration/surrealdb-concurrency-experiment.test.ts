import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import {
  connectSurrealConcurrencyExperiment,
  isSurrealConcurrencyConflict,
} from "../../packages/storage-surrealdb/src/concurrency-experiment.ts";
import { connectSurrealProjectStorageSubsetHarness } from "../../packages/storage-surrealdb/src/project-storage/test-support.ts";

const endpoint = process.env.AI_OFFICE_TEST_SURREALDB_URL;
const iterations = 40;
const fixedNow = new Date("2026-09-27T12:00:00.000Z");
const closers: Array<() => Promise<void>> = [];

describe.skipIf(endpoint === undefined)("SurrealDB concurrency evaluation", () => {
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  test(`atomic claim allows one winner in ${iterations} independent-client races`, async () => {
    const pair = await openPair();
    for (let index = 0; index < iterations; index += 1) {
      const id = `claim-${index}`;
      await pair.a.create({ id, owner: "", leaseUntil: new Date(0) });
      const start = barrier(2);
      const attempts = await Promise.allSettled([
        start().then(() =>
          pair.a.claim({
            id,
            owner: "worker-a",
            now: fixedNow,
            leaseUntil: addSeconds(fixedNow, 30),
          }),
        ),
        start().then(() =>
          pair.b.claim({
            id,
            owner: "worker-b",
            now: fixedNow,
            leaseUntil: addSeconds(fixedNow, 30),
          }),
        ),
      ]);
      const winners = attempts.filter((attempt) => attempt.status === "fulfilled" && attempt.value);
      const errors = attempts.filter((attempt) => attempt.status === "rejected");
      expect(winners, JSON.stringify(attempts)).toHaveLength(1);
      expect(errors, "a losing atomic update should return no row, not fail").toHaveLength(0);
      const stored = await pair.a.read(id);
      expect(["worker-a", "worker-b"]).toContain(stored?.owner);
      expect(stored?.fence).toBe(1);
    }
  });

  test(`lease renewal, expiry, reclaim, and stale-owner fencing remain scoped in ${iterations} runs`, async () => {
    const pair = await openPair();
    for (let index = 0; index < iterations; index += 1) {
      const id = `lease-${index}`;
      const expiry = addSeconds(fixedNow, 30);
      await pair.a.create({
        id,
        owner: "",
        leaseUntil: new Date(0),
        runStatus: "running",
      });
      expect(
        await pair.a.claim({
          id,
          owner: "worker-a",
          now: fixedNow,
          leaseUntil: expiry,
        }),
      ).toBe(true);
      expect(
        await pair.a.renew({
          id,
          owner: "worker-a",
          fence: 1,
          now: fixedNow,
          leaseUntil: addSeconds(fixedNow, 60),
        }),
      ).toBe(true);
      expect(
        await pair.b.renew({
          id,
          owner: "worker-b",
          fence: 1,
          now: fixedNow,
          leaseUntil: addSeconds(fixedNow, 90),
        }),
      ).toBe(false);
      expect(
        await pair.b.claim({
          id,
          owner: "worker-b",
          now: fixedNow,
          leaseUntil: addSeconds(fixedNow, 30),
        }),
      ).toBe(false);
      const expired = addSeconds(fixedNow, 61);
      expect(
        await pair.b.claim({
          id,
          owner: "worker-b",
          now: expired,
          leaseUntil: addSeconds(expired, 30),
        }),
      ).toBe(true);
      expect(
        await pair.a.mutateWithFence({
          id,
          owner: "worker-a",
          fence: 1,
          now: expired,
          value: "stale-write",
        }),
      ).toBe(false);
      expect(
        await pair.b.mutateWithFence({
          id,
          owner: "worker-b",
          fence: 2,
          now: expired,
          value: "worker-b-write",
        }),
      ).toBe(true);
      expect(await pair.a.read(id)).toMatchObject({
        owner: "worker-b",
        fence: 2,
        protected_value: "worker-b-write",
      });
    }
  });

  test(`expected-version compare-and-set accepts one of two writers in ${iterations} races`, async () => {
    const pair = await openPair();
    for (let index = 0; index < iterations; index += 1) {
      const id = `version-${index}`;
      await pair.a.create({ id, owner: "", leaseUntil: new Date(0), version: 5 });
      const start = barrier(2);
      const attempts = await Promise.all([
        start().then(() => pair.a.compareAndSetVersion({ id, expectedVersion: 5 })),
        start().then(() => pair.b.compareAndSetVersion({ id, expectedVersion: 5 })),
      ]);
      expect(attempts.filter(Boolean)).toHaveLength(1);
      expect((await pair.a.read(id))?.version).toBe(6);
    }
  });

  test(`terminal agent-run state cannot be resurrected by a stale transition in ${iterations} races`, async () => {
    const pair = await openPair();
    for (let index = 0; index < iterations; index += 1) {
      const id = `terminal-${index}`;
      await pair.a.create({
        id,
        owner: "",
        leaseUntil: new Date(0),
        runStatus: "running",
      });
      expect(
        await pair.a.transitionRun({
          id,
          expectedStatus: "running",
          nextStatus: "completed",
        }),
      ).toBe(true);
      expect(
        await pair.b.transitionRun({
          id,
          expectedStatus: "running",
          nextStatus: "queued",
        }),
      ).toBe(false);
      expect((await pair.a.read(id))?.run_status).toBe("completed");
    }
  });

  test("snapshot isolation rejects a same-record lost update and permits write skew on disjoint records", async () => {
    const pair = await openPair();
    for (let index = 0; index < iterations; index += 1) {
      const lostUpdateId = `lost-update-${index}`;
      await pair.a.create({ id: lostUpdateId, owner: "", leaseUntil: new Date(0) });
      const txA = await pair.dbA.beginTransaction();
      const txB = await pair.dbB.beginTransaction();
      const bothRead = barrier(2);
      const updates = await Promise.allSettled([
        txIncrement(txA, lostUpdateId, bothRead),
        txIncrement(txB, lostUpdateId, bothRead),
      ]);
      expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(updates.filter((result) => result.status === "rejected")).toHaveLength(1);
      const lostUpdate = updates.find((result) => result.status === "rejected");
      expect(
        lostUpdate?.status === "rejected" && isSurrealConcurrencyConflict(lostUpdate.reason),
      ).toBe(true);
      expect((await pair.a.read(lostUpdateId))?.version).toBe(2);

      const skewAId = `skew-a-${index}`;
      const skewBId = `skew-b-${index}`;
      await pair.a.create({
        id: skewAId,
        owner: "",
        leaseUntil: new Date(0),
        version: 1,
        protectedValue: "active",
      });
      await pair.a.create({
        id: skewBId,
        owner: "",
        leaseUntil: new Date(0),
        version: 1,
        protectedValue: "active",
      });
      const skewA = await pair.dbA.beginTransaction();
      const skewB = await pair.dbB.beginTransaction();
      const bothObserved = barrier(2);
      const skew = await Promise.allSettled([
        txWriteSkew(skewA, skewAId, skewBId, skewAId, "a-off", bothObserved),
        txWriteSkew(skewB, skewAId, skewBId, skewBId, "b-off", bothObserved),
      ]);
      expect(skew.filter((result) => result.status === "fulfilled")).toHaveLength(2);
      const finalA = await pair.a.read(skewAId);
      const finalB = await pair.a.read(skewBId);
      expect(finalA?.protected_value).toBe("a-off");
      expect(finalB?.protected_value).toBe("b-off");
      expect([finalA, finalB].some((record) => record?.protected_value === "active")).toBe(false);

      const lockedAId = `locked-skew-a-${index}`;
      const lockedBId = `locked-skew-b-${index}`;
      await pair.a.create({
        id: lockedAId,
        owner: "",
        leaseUntil: new Date(0),
        protectedValue: "active",
      });
      await pair.a.create({
        id: lockedBId,
        owner: "",
        leaseUntil: new Date(0),
        protectedValue: "active",
      });
      const lockedTxA = await pair.dbA.beginTransaction();
      const lockedTxB = await pair.dbB.beginTransaction();
      const bothLocked = barrier(2);
      const lockedSkew = await Promise.allSettled([
        txWriteSkew(lockedTxA, lockedAId, lockedBId, lockedAId, "a-off", bothLocked, true),
        txWriteSkew(lockedTxB, lockedAId, lockedBId, lockedBId, "b-off", bothLocked, true),
      ]);
      expect(lockedSkew.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const lockedConflict = lockedSkew.find((result) => result.status === "rejected");
      expect(
        lockedConflict?.status === "rejected" &&
          isSurrealConcurrencyConflict(lockedConflict.reason),
      ).toBe(true);
      const lockedFinalA = await pair.a.read(lockedAId);
      const lockedFinalB = await pair.a.read(lockedBId);
      expect([lockedFinalA, lockedFinalB].filter((record) => record?.protected_value === "active")).toHaveLength(1);
    }
  });

  test(`PR #65 task saves expose concurrent ownership validation results in ${iterations} races`, async () => {
    const pair = await openPair();
    for (let index = 0; index < iterations; index += 1) {
      const projectA = `save-a-${index}`;
      const projectB = `save-b-${index}`;
      await pair.projectA.experiment.projects.save(
        Project.create({ id: projectA, name: projectA, now: fixedNow }),
      );
      await pair.projectA.experiment.projects.save(
        Project.create({ id: projectB, name: projectB, now: fixedNow }),
      );
      const taskId = `shared-task-${index}`;
      const taskA = Task.create({ id: taskId, projectId: projectA, title: "A", now: fixedNow });
      const taskB = Task.create({ id: taskId, projectId: projectB, title: "B", now: fixedNow });
      const start = barrier(2);
      const writes = await Promise.allSettled([
        start().then(() => pair.projectA.experiment.tasks.save(taskA)),
        start().then(() => pair.projectB.experiment.tasks.save(taskB)),
      ]);
      const winners = writes.filter((write) => write.status === "fulfilled");
      expect(winners).toHaveLength(1);
      expect(writes.filter((write) => write.status === "rejected")).toHaveLength(1);
      const owners = await Promise.all(
        [projectA, projectB].map((projectId) =>
          pair.projectA.projectOwnsTask(projectId, taskId),
        ),
      );
      expect(owners.filter(Boolean)).toHaveLength(1);
    }
  });

  test(`PR #65 relation pre-reads race with the unique relation index across ${iterations} runs`, async () => {
    const pair = await openPair();
    for (let index = 0; index < iterations; index += 1) {
      const projectId = `link-project-${index}`;
      const taskId = `link-task-${index}`;
      const requirementId = `link-requirement-${index}`;
      await pair.projectA.experiment.projects.save(
        Project.create({ id: projectId, name: projectId, now: fixedNow }),
      );
      await pair.projectA.experiment.tasks.save(
        Task.create({ id: taskId, projectId, title: taskId, now: fixedNow }),
      );
      await pair.projectA.seedRequirement({
        id: requirementId,
        tenantId: "concurrency-tenant",
        projectId,
        key: `R-${index}`,
        title: `Requirement ${index}`,
        status: "accepted",
      });
      const start = barrier(2);
      const links = await Promise.allSettled([
        start().then(() =>
          pair.projectA.experiment.taskRequirements.link({
            projectId,
            taskId,
            requirementId,
            now: fixedNow,
          }),
        ),
        start().then(() =>
          pair.projectB.experiment.taskRequirements.link({
            projectId,
            taskId,
            requirementId,
            now: fixedNow,
          }),
        ),
      ]);
      expect(links.filter((link) => link.status === "fulfilled" && link.value)).toHaveLength(1);
      expect(links.filter((link) => link.status === "rejected")).toHaveLength(1);
      expect(
        (await pair.projectA.experiment.taskRequirements.listForTask(projectId, taskId)),
      ).toHaveLength(1);
    }
  });
});

function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await open;
  };
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

async function openPair() {
  if (endpoint === undefined) throw new Error("SurrealDB test endpoint is required");
  const database = `concurrency_${randomUUID().replaceAll("-", "")}`;
  const dbA = await connectSurrealConcurrencyExperiment({
    endpoint,
    namespace: "ai_office_tests",
    database,
  });
  const dbB = await connectSurrealConcurrencyExperiment({
    endpoint,
    namespace: "ai_office_tests",
    database,
  });
  const projectA = await connectSurrealProjectStorageSubsetHarness({
    endpoint,
    namespace: "ai_office_tests",
    database,
    tenantId: "concurrency-tenant",
  });
  const projectB = await connectSurrealProjectStorageSubsetHarness({
    endpoint,
    namespace: "ai_office_tests",
    database,
    tenantId: "concurrency-tenant",
  });
  closers.push(dbA.close, dbB.close, projectA.close, projectB.close);
  return {
    a: dbA.experiment,
    b: dbB.experiment,
    dbA: dbA.database,
    dbB: dbB.database,
    projectA,
    projectB,
  };
}

async function txIncrement(
  transaction: ExperimentTransaction,
  id: string,
  rendezvous: () => Promise<void>,
): Promise<void> {
  try {
    await transaction.query("SELECT * FROM ONLY type::record('concurrency_probe', $id)", { id });
    await rendezvous();
    await transaction.query(
      "UPDATE ONLY type::record('concurrency_probe', $id) SET version += 1",
      { id },
    );
    await transaction.commit();
  } catch (error) {
    await transaction.cancel().catch(() => undefined);
    throw error;
  }
}

async function txWriteSkew(
  transaction: ExperimentTransaction,
  idA: string,
  idB: string,
  writeId: string,
  value: string,
  rendezvous: () => Promise<void>,
  lockRows = false,
): Promise<void> {
  try {
    if (lockRows) {
      await transaction.query(
        "SELECT * FROM ONLY type::record('concurrency_probe', $id_a) FOR UPDATE",
        { id_a: idA },
      );
      await transaction.query(
        "SELECT * FROM ONLY type::record('concurrency_probe', $id_b) FOR UPDATE",
        { id_b: idB },
      );
    }
    const [records] = await transaction.query<[Array<Record<string, unknown>>]>(
      "SELECT * FROM concurrency_probe WHERE id IN [type::record('concurrency_probe', $id_a), type::record('concurrency_probe', $id_b)]",
      { id_a: idA, id_b: idB },
    );
    if (
      records?.length !== 2 ||
      records.some((record) => record.protected_value !== "active")
    )
      throw new Error("The write-skew precondition changed before the transaction read");
    await rendezvous();
    await transaction.query(
      "UPDATE ONLY type::record('concurrency_probe', $id) SET protected_value = $value",
      { id: writeId, value },
    );
    await transaction.commit();
  } catch (error) {
    await transaction.cancel().catch(() => undefined);
    throw error;
  }
}

interface ExperimentTransaction {
  query<T extends unknown[]>(
    statement: string,
    variables?: Record<string, unknown>,
  ): Promise<T>;
  commit(): Promise<void>;
  cancel(): Promise<void>;
}
