import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuditEvent } from "@ai-office/domain/event/audit-event.ts";
import type { AuditEventRepository } from "@ai-office/application/ports/audit-event-repository.port.ts";

export interface AuditEventContractHarness {
  repository: AuditEventRepository;
  projectId: string;
  idPrefix: string;
  now: Date;
  findById(id: string): Promise<Record<string, unknown> | null>;
  countById(id: string): Promise<number>;
  appendAndRollback(event: AuditEvent): Promise<void>;
  close(): Promise<void>;
}

export function defineAuditEventRepositoryContracts(
  createHarness: () => Promise<AuditEventContractHarness>,
): void {
  let harness: AuditEventContractHarness;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness.close();
  });

  describe("AuditEventRepository shared contract", () => {
    test("appends and preserves project, actor, aggregate, and payload fields", async () => {
      const event = AuditEvent.create({
        id: `${harness.idPrefix}-round-trip`,
        eventType: "contract.appended",
        actorType: "system",
        actorId: "contractor",
        aggregateType: "run",
        aggregateId: "run-1",
        projectId: harness.projectId,
        payload: { answer: 42, nested: { ok: true } },
        occurredAt: harness.now,
      });
      await harness.repository.append(event);
      expect(await harness.findById(event.snapshot().id)).toEqual({
        event_type: "contract.appended",
        actor_type: "system",
        actor_id: "contractor",
        aggregate_type: "run",
        aggregate_id: "run-1",
        project_id: harness.projectId,
        payload: { answer: 42, nested: { ok: true } },
      });
    });

    test("rejects duplicate IDs without creating a second row", async () => {
      const id = `${harness.idPrefix}-duplicate`;
      const event = AuditEvent.create({
        id,
        eventType: "contract.duplicate",
        actorType: "system",
        projectId: harness.projectId,
        payload: {},
        occurredAt: harness.now,
      });
      await harness.repository.append(event);
      await expect(harness.repository.append(event)).rejects.toThrow();
      expect(await harness.countById(id)).toBe(1);
    });

    test("rolls back an append inside the transaction boundary", async () => {
      const id = `${harness.idPrefix}-rollback`;
      await expect(
        harness.appendAndRollback(
          AuditEvent.create({
            id,
            eventType: "contract.rollback",
            actorType: "system",
            projectId: harness.projectId,
            payload: {},
            occurredAt: harness.now,
          }),
        ),
      ).rejects.toThrow("contract rollback");
      expect(await harness.findById(id)).toBeNull();
    });
  });
}
