import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CreateCapabilityGrant } from "@ai-office/application/capability/create-capability-grant.ts";
import { hashCanonicalActionPayload } from "@ai-office/application/capability/canonical-action.ts";
import { EvaluateActionPolicy } from "@ai-office/application/capability/evaluate-action-policy.ts";
import { DisableResource } from "@ai-office/application/capability/disable-resource.ts";
import { RegisterResource } from "@ai-office/application/capability/register-resource.ts";
import { RequestControlledAction } from "@ai-office/application/capability/request-controlled-action.ts";
import { RevokeCapabilityGrant } from "@ai-office/application/capability/revoke-capability-grant.ts";
import {
  CapabilityGrantRevokedError,
  ResourceDisabledError,
} from "@ai-office/application/capability-errors.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import type { CanonicalActionPayload } from "@ai-office/domain/capability/action-request.ts";
import { fakeConnectorDescriptor } from "@ai-office/domain/capability/capability.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { SqliteCapabilityPolicyRepository } from "@ai-office/storage-sqlite/repositories/sqlite-capability-policy.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";

const roots: string[] = [];
const migrations = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
  "project",
);

class MutableClock implements Clock {
  value = new Date("2026-08-05T12:00:00.000Z");
  now(): Date {
    return new Date(this.value);
  }
}
class Ids implements IdGenerator {
  private next = 0;
  generate(): string {
    return `m6a-${++this.next}`;
  }
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("M6A capability persistence and services", () => {
  test("persists deterministic decisions, revocation, project isolation, and security audit", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-m6a-storage-"));
    roots.push(root);
    const untouchedPath = join(root, "must-not-be-created.txt");
    const database = openDatabase(join(root, "project.sqlite"));
    migrate(database, migrations);
    const clock = new MutableClock();
    const ids = new Ids();
    const projects = new SqliteProjectRepository(database);
    const runtime = new SqliteAgentRuntimeRepository(database);
    const capabilities = new SqliteCapabilityPolicyRepository(database);
    const transactions = new SqliteTransactionRunner(database);
    const audit = new RecordAuditEvent(
      new SqliteAuditEventRepository(database),
      ids,
      clock,
    );
    await projects.save(
      Project.create({ id: "project-1", name: "One", now: clock.now() }),
    );
    await projects.save(
      Project.create({ id: "project-2", name: "Two", now: clock.now() }),
    );
    await runtime.saveRole(
      Role.create({
        id: "role-1",
        projectId: "project-1",
        key: "developer",
        name: "Developer",
        version: 1,
        capabilities: [],
        tools: [],
        modelPolicy: "mock",
        limits: { maxIterations: 1, maxCostMicros: 0n, timeoutSeconds: 60 },
        sourcePath: "agents/developer",
        now: clock.now(),
      }),
    );
    await runtime.saveAgent({
      id: "agent-1",
      projectId: "project-1",
      roleId: "role-1",
      name: "Agent",
      enabled: true,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
    const register = new RegisterResource(
      projects,
      capabilities,
      audit,
      ids,
      clock,
      transactions,
    );
    const first = await register.execute({
      projectId: "project-1",
      type: "filesystem_scope",
      provider: "fake",
      externalRef: untouchedPath,
      displayName: "Logical fake",
      configuration: { label: "no I/O" },
    });
    const substitute = await register.execute({
      projectId: "project-1",
      type: "filesystem_scope",
      provider: "fake",
      displayName: "Substitute",
      configuration: {},
    });
    const otherProjectResource = await register.execute({
      projectId: "project-2",
      type: "filesystem_scope",
      provider: "fake",
      displayName: "Other project",
      configuration: {},
    });
    database
      .prepare(
        `INSERT INTO resources(
          id, project_id, type, provider, display_name, configuration_json,
          credential_ref, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "resource-with-credential",
        "project-1",
        "filesystem_scope",
        "fake",
        "Credential redaction fixture",
        "{}",
        "secret-reference",
        "active",
        clock.now().toISOString(),
        clock.now().toISOString(),
      );
    const evaluate = new EvaluateActionPolicy(runtime, capabilities, clock);
    const request = new RequestControlledAction(
      evaluate,
      capabilities,
      audit,
      ids,
      clock,
      transactions,
    );

    expect(
      (
        await request.execute({
          projectId: "project-1",
          agentId: "agent-1",
          resourceId: first.id,
          operation: "fake.read",
          arguments: { target: "readme" },
        })
      ).outcome,
    ).toBe("denied");

    const grantService = new CreateCapabilityGrant(
      projects,
      runtime,
      capabilities,
      audit,
      ids,
      clock,
      transactions,
    );
    await grantService.execute({
      projectId: "project-1",
      principalType: "agent",
      principalId: "agent-1",
      resourceId: substitute.id,
      actions: ["fake.read"],
      grantedBy: "owner",
      reason: "disabled resource test",
    });
    const disable = new DisableResource(
      capabilities,
      audit,
      clock,
      transactions,
    );
    await disable.execute({
      projectId: "project-1",
      resourceId: substitute.id,
    });
    await expect(
      disable.execute({ projectId: "project-1", resourceId: substitute.id }),
    ).rejects.toBeInstanceOf(ResourceDisabledError);
    expect(
      (
        await request.execute({
          projectId: "project-1",
          agentId: "agent-1",
          resourceId: substitute.id,
          operation: "fake.read",
          arguments: { target: "readme" },
        })
      ).outcome,
    ).toBe("denied");
    await grantService.execute({
      projectId: "project-2",
      principalType: "user",
      principalId: "owner-2",
      resourceId: otherProjectResource.id,
      actions: ["fake.read"],
      grantedBy: "owner-2",
      reason: "must not authorize project one",
    });
    expect(
      (
        await request.execute({
          projectId: "project-1",
          agentId: "agent-1",
          resourceId: first.id,
          operation: "fake.read",
          arguments: { target: "readme" },
        })
      ).outcome,
    ).toBe("denied");
    const readGrant = await grantService.execute({
      projectId: "project-1",
      principalType: "agent",
      principalId: "agent-1",
      resourceId: first.id,
      actions: ["fake.read"],
      grantedBy: "owner",
      reason: "read only",
    });
    expect(
      (
        await request.execute({
          projectId: "project-1",
          agentId: "agent-1",
          resourceId: first.id,
          operation: "fake.read",
          arguments: { target: "readme" },
        })
      ).outcome,
    ).toBe("allowed");
    expect(
      (
        await request.execute({
          projectId: "project-1",
          agentId: "agent-1",
          resourceId: first.id,
          operation: "fake.write",
          arguments: { target: "readme", content: "never written" },
        })
      ).outcome,
    ).toBe("denied");
    expect(
      (
        await request.execute({
          projectId: "project-1",
          agentId: "agent-1",
          resourceId: substitute.id,
          operation: "fake.read",
          arguments: { target: "readme" },
        })
      ).outcome,
    ).toBe("denied");

    await grantService.execute({
      projectId: "project-1",
      principalType: "role",
      principalId: "role-1",
      resourceId: first.id,
      actions: ["fake.write"],
      constraints: { allowMutation: true },
      grantedBy: "owner",
      reason: "simulate writes",
    });
    expect(
      (
        await request.execute({
          projectId: "project-1",
          agentId: "agent-1",
          resourceId: first.id,
          operation: "fake.write",
          arguments: { target: "readme", content: "never written" },
        })
      ).outcome,
    ).toBe("simulation_required");
    await grantService.execute({
      projectId: "project-1",
      principalType: "agent",
      principalId: "agent-1",
      resourceId: first.id,
      actions: ["fake.delete"],
      constraints: { allowMutation: true },
      grantedBy: "owner",
      reason: "approval demonstration",
    });
    expect(
      (
        await request.execute({
          projectId: "project-1",
          agentId: "agent-1",
          resourceId: first.id,
          operation: "fake.delete",
          arguments: { target: "readme" },
        })
      ).outcome,
    ).toBe("approval_required");

    await new RevokeCapabilityGrant(
      capabilities,
      audit,
      clock,
      transactions,
    ).execute({
      projectId: "project-1",
      grantId: readGrant.id,
      revokedBy: "owner",
    });
    await expect(
      new RevokeCapabilityGrant(
        capabilities,
        audit,
        clock,
        transactions,
      ).execute({
        projectId: "project-1",
        grantId: readGrant.id,
        revokedBy: "owner",
      }),
    ).rejects.toBeInstanceOf(CapabilityGrantRevokedError);
    expect(
      (
        await request.execute({
          projectId: "project-1",
          agentId: "agent-1",
          resourceId: first.id,
          operation: "fake.read",
          arguments: { target: "readme" },
        })
      ).outcome,
    ).toBe("denied");

    const events = database
      .query<
        {
          event_type: string;
          actor_type: string;
          actor_id: string | null;
          project_id: string | null;
          payload_json: string;
        },
        []
      >(
        `SELECT event_type, actor_type, actor_id, project_id, payload_json
         FROM audit_event ORDER BY occurred_at, id`,
      )
      .all();
    expect(events.map((event) => event.event_type)).toContain(
      "action.requested",
    );
    expect(events.map((event) => event.event_type)).toContain(
      "action.authorized",
    );
    expect(events.map((event) => event.event_type)).toContain("action.denied");
    expect(events.map((event) => event.event_type)).toContain(
      "capability.revoked",
    );
    expect(
      events.find((event) => event.event_type === "resource.registered"),
    ).toMatchObject({
      actor_type: "cli",
      actor_id: "local-cli",
      project_id: "project-1",
    });
    expect(
      events.find((event) => event.event_type === "action.authorized"),
    ).toMatchObject({
      actor_type: "system",
      actor_id: "agent-1",
      project_id: "project-1",
    });
    expect(
      events.some((event) => event.payload_json.includes("never written")),
    ).toBe(false);
    expect(
      events.some((event) => event.payload_json.includes("secret-reference")),
    ).toBe(false);

    const authorizedRow = database
      .query<
        {
          project_id: string;
          agent_id: string;
          resource_id: string;
          connector: string;
          connector_version: string;
          operation: string;
          normalized_arguments_json: string;
          effective_constraints_json: string;
          payload_hash: string;
        },
        []
      >(
        `SELECT project_id, agent_id, resource_id, connector, connector_version,
          operation, normalized_arguments_json, effective_constraints_json,
          payload_hash
         FROM action_requests
         WHERE decision='allow'
         ORDER BY created_at, id
         LIMIT 1`,
      )
      .get();
    expect(authorizedRow).not.toBeNull();
    const persistedPayload: CanonicalActionPayload = {
      schemaVersion: 1,
      projectId: authorizedRow!.project_id,
      agentId: authorizedRow!.agent_id,
      resourceId: authorizedRow!.resource_id,
      connector: authorizedRow!.connector,
      connectorVersion: authorizedRow!.connector_version,
      operation: authorizedRow!.operation,
      normalizedArguments: JSON.parse(
        authorizedRow!.normalized_arguments_json,
      ) as unknown,
      effectiveConstraints: JSON.parse(
        authorizedRow!.effective_constraints_json,
      ) as unknown,
    };
    expect(hashCanonicalActionPayload(persistedPayload).hash).toBe(
      authorizedRow!.payload_hash,
    );
    expect(authorizedRow).toMatchObject({
      connector: fakeConnectorDescriptor.id,
      connector_version: fakeConnectorDescriptor.version,
    });
    const deniedConnector = database
      .query<{ connector: string; connector_version: string }, []>(
        `SELECT connector, connector_version
         FROM action_requests
         WHERE decision='deny'
         ORDER BY created_at, id
         LIMIT 1`,
      )
      .get();
    expect(deniedConnector).toEqual({
      connector: fakeConnectorDescriptor.id,
      connector_version: fakeConnectorDescriptor.version,
    });

    const resources = await capabilities.listResources("project-1");
    expect(resources.map((value) => value.id)).toEqual(
      [...resources]
        .sort(
          (left, right) =>
            left.createdAt.getTime() - right.createdAt.getTime() ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        )
        .map((value) => value.id),
    );
    const grants = await capabilities.listGrants("project-1");
    expect(grants.map((value) => value.id)).toEqual(
      [...grants]
        .sort(
          (left, right) =>
            left.createdAt.getTime() - right.createdAt.getTime() ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        )
        .map((value) => value.id),
    );
    const actions = await capabilities.listActionRequests("project-1");
    expect(actions.map((value) => value.snapshot().id)).toEqual(
      [...actions]
        .sort((left, right) => {
          const leftValue = left.snapshot();
          const rightValue = right.snapshot();
          return (
            leftValue.createdAt.getTime() - rightValue.createdAt.getTime() ||
            (leftValue.id < rightValue.id
              ? -1
              : leftValue.id > rightValue.id
                ? 1
                : 0)
          );
        })
        .map((value) => value.snapshot().id),
    );
    expect(existsSync(untouchedPath)).toBe(false);
    expect(
      (await capabilities.findResource("resource-with-credential"))
        ?.credentialRef,
    ).toBeUndefined();
    expect(resources.some((value) => value.credentialRef !== undefined)).toBe(
      false,
    );
    database.close();
  });
});
