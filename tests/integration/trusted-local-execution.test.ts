import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  ActionRequestNotFoundError,
  CapabilityProjectMismatchError,
  InvalidActionApprovalStateError,
  InvalidActionExecutionStateError,
  StaleActionAuthorizationError,
} from "@ai-office/application/capability-errors.ts";
import { CreateCapabilityGrant } from "@ai-office/application/capability/create-capability-grant.ts";
import { DecideControlledAction } from "@ai-office/application/capability/decide-controlled-action.ts";
import { DisableResource } from "@ai-office/application/capability/disable-resource.ts";
import { EvaluateActionPolicy } from "@ai-office/application/capability/evaluate-action-policy.ts";
import { ExecuteControlledAction } from "@ai-office/application/capability/execute-controlled-action.ts";
import { InvokeControlledConnectorAction } from "@ai-office/application/capability/invoke-controlled-connector-action.ts";
import { RegisterResource } from "@ai-office/application/capability/register-resource.ts";
import { RequestControlledAction } from "@ai-office/application/capability/request-controlled-action.ts";
import { RevokeCapabilityGrant } from "@ai-office/application/capability/revoke-capability-grant.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import type { AuditEventRepository } from "@ai-office/application/ports/audit-event-repository.port.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { ConnectorRegistry } from "@ai-office/connector-sdk/connector-registry.ts";
import type { ConnectorDefinition } from "@ai-office/connector-sdk/connector.ts";
import { ConnectorMutationExecutionError } from "@ai-office/connector-sdk/errors.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import type { AuditEvent } from "@ai-office/domain/event/audit-event.ts";
import { createDefaultConnectorRegistry } from "@ai-office/filesystem-connector/default-connector-registry.ts";
import { filesystemConnectorDefinition } from "@ai-office/filesystem-connector/filesystem-connector.ts";
import { parseEffectiveFilesystemConstraints } from "@ai-office/filesystem-connector/filesystem-constraints.ts";
import { FilesystemSandbox } from "@ai-office/filesystem-connector/filesystem-sandbox.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { SqliteCapabilityPolicyRepository } from "@ai-office/storage-sqlite/repositories/sqlite-capability-policy.repository.ts";
import { SqliteControlledExecutionRepository } from "@ai-office/storage-sqlite/repositories/sqlite-controlled-execution.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";

const roots: string[] = [];
const migrations = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
  "project",
);

class TestClock implements Clock {
  private milliseconds = Date.parse("2026-08-11T08:00:00.000Z");
  now(): Date {
    this.milliseconds += 1;
    return new Date(this.milliseconds);
  }
  advance(milliseconds: number): void {
    this.milliseconds += milliseconds;
  }
}

class TestIds implements IdGenerator {
  private value = 0;
  generate(): string {
    this.value += 1;
    return `m6c-lite-${this.value}`;
  }
}

class FailAuditEvent implements AuditEventRepository {
  private readonly eventTypes: ReadonlySet<string>;

  constructor(
    private readonly delegate: AuditEventRepository,
    eventTypes: string | readonly string[],
  ) {
    this.eventTypes = new Set(
      typeof eventTypes === "string" ? [eventTypes] : eventTypes,
    );
  }
  async append(event: AuditEvent): Promise<void> {
    if (this.eventTypes.has(event.snapshot().eventType))
      throw new Error("injected audit failure");
    await this.delegate.append(event);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(
  registry = createDefaultConnectorRegistry(),
  failAuditEvents?: string | readonly string[],
) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ai-office-m6c-lite-")));
  roots.push(directory);
  const workspace = join(directory, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "index.ts"), "export const value = 1;\n");
  const database = openDatabase(join(directory, "project.sqlite"));
  migrate(database, migrations);
  const clock = new TestClock();
  const ids = new TestIds();
  const projects = new SqliteProjectRepository(database);
  const runtime = new SqliteAgentRuntimeRepository(database);
  const capabilities = new SqliteCapabilityPolicyRepository(database);
  const controlled = new SqliteControlledExecutionRepository(database);
  const auditStorage = new SqliteAuditEventRepository(database);
  const audit = new RecordAuditEvent(
    failAuditEvents === undefined
      ? auditStorage
      : new FailAuditEvent(auditStorage, failAuditEvents),
    ids,
    clock,
  );
  const transactions = new SqliteTransactionRunner(database);
  await projects.save(Project.create({ id: "project-1", name: "M6C lite", now: clock.now() }));
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
  const resource = await new RegisterResource(
    projects,
    capabilities,
    audit,
    ids,
    clock,
    transactions,
    registry,
  ).execute({
    projectId: "project-1",
    type: "filesystem_scope",
    provider: "filesystem",
    externalRef: workspace,
    displayName: "Workspace",
    configuration: {},
  });
  const grantService = new CreateCapabilityGrant(
    projects,
    runtime,
    capabilities,
    audit,
    ids,
    clock,
    transactions,
    registry,
  );
  const evaluator = new EvaluateActionPolicy(runtime, capabilities, clock, registry);
  const request = new RequestControlledAction(
    evaluator,
    capabilities,
    audit,
    ids,
    clock,
    transactions,
  );
  const invoke = new InvokeControlledConnectorAction(
    request,
    capabilities,
    audit,
    ids,
    clock,
    transactions,
    registry,
    evaluator,
    controlled,
  );
  const decide = new DecideControlledAction(
    capabilities,
    controlled,
    audit,
    clock,
    transactions,
  );
  const execute = new ExecuteControlledAction(
    capabilities,
    controlled,
    audit,
    ids,
    clock,
    transactions,
    registry,
    evaluator,
  );
  return {
    database,
    workspace,
    clock,
    ids,
    resource,
    capabilities,
    controlled,
    audit,
    transactions,
    runtime,
    evaluator,
    registry,
    grantService,
    invoke,
    decide,
    execute,
  };
}

async function grant(
  context: Awaited<ReturnType<typeof fixture>>,
  action: string,
  expiresAt?: Date,
) {
  return context.grantService.execute({
    projectId: "project-1",
    principalType: "agent",
    principalId: "agent-1",
    resourceId: context.resource.id,
    actions: [action],
    constraints: { allowMutation: true },
    ...(expiresAt === undefined ? {} : { expiresAt }),
    grantedBy: "owner",
    reason: "M6C-lite integration",
  });
}

async function simulate(
  context: Awaited<ReturnType<typeof fixture>>,
  operation: string,
  arguments_: Readonly<Record<string, unknown>>,
) {
  await grant(context, operation);
  const result = await context.invoke.execute({
    projectId: "project-1",
    agentId: "agent-1",
    resourceId: context.resource.id,
    operation,
    arguments: arguments_,
  });
  expect(result).toMatchObject({ outcome: "approval_required", status: "approval_pending" });
  return result.requestId;
}

async function approve(
  context: Awaited<ReturnType<typeof fixture>>,
  actionRequestId: string,
) {
  return context.decide.approve({
    projectId: "project-1",
    actionRequestId,
    actor: "local-user",
  });
}

describe("M6C-lite trusted local execution", () => {
  test("executes create, write, move, and delete only after structured approval", async () => {
    const createContext = await fixture();
    const createId = await simulate(createContext, "filesystem.create", {
      path: "src/new.ts",
      content: "export const created = true;\n",
    });
    expect(readFileSync(join(createContext.workspace, "src", "index.ts"), "utf8"))
      .toBe("export const value = 1;\n");
    await approve(createContext, createId);
    await expect(createContext.execute.execute({ projectId: "project-1", actionRequestId: createId }))
      .resolves.toMatchObject({ status: "completed" });
    expect(readFileSync(join(createContext.workspace, "src", "new.ts"), "utf8"))
      .toBe("export const created = true;\n");
    expect(statSync(join(createContext.workspace, "src", "new.ts")).mode & 0o777)
      .toBe(0o600);
    createContext.database.close();

    const writeContext = await fixture();
    const writeId = await simulate(writeContext, "filesystem.write", {
      path: "src/index.ts",
      content: "export const value = 2;\n",
    });
    await approve(writeContext, writeId);
    expect(await writeContext.execute.execute({ projectId: "project-1", actionRequestId: writeId }))
      .toMatchObject({ status: "completed" });
    expect(readFileSync(join(writeContext.workspace, "src", "index.ts"), "utf8"))
      .toBe("export const value = 2;\n");
    writeContext.database.close();

    const moveContext = await fixture();
    const moveId = await simulate(moveContext, "filesystem.move", {
      sourcePath: "src/index.ts",
      destinationPath: "src/moved.ts",
    });
    await approve(moveContext, moveId);
    expect(await moveContext.execute.execute({ projectId: "project-1", actionRequestId: moveId }))
      .toMatchObject({ status: "completed" });
    expect(readFileSync(join(moveContext.workspace, "src", "moved.ts"), "utf8"))
      .toBe("export const value = 1;\n");
    moveContext.database.close();

    const deleteContext = await fixture();
    const deleteId = await simulate(deleteContext, "filesystem.delete", { path: "src/index.ts" });
    await approve(deleteContext, deleteId);
    expect(await deleteContext.execute.execute({ projectId: "project-1", actionRequestId: deleteId }))
      .toMatchObject({ status: "completed" });
    expect(() => readFileSync(join(deleteContext.workspace, "src", "index.ts")))
      .toThrow();
    deleteContext.database.close();
  });

  test("write preserves ordinary executable and non-executable permission bits", async () => {
    const context = await fixture();
    for (const item of [
      { path: "src/tool.sh", mode: 0o755, content: "#!/bin/sh\nexit 0\n" },
      { path: "src/private.txt", mode: 0o640, content: "before\n" },
    ]) {
      const absolute = join(context.workspace, item.path);
      writeFileSync(absolute, item.content);
      chmodSync(absolute, item.mode);
      const actionRequestId = await simulate(context, "filesystem.write", {
        path: item.path,
        content: "replacement\n",
      });
      await approve(context, actionRequestId);
      await expect(
        context.execute.execute({ projectId: "project-1", actionRequestId }),
      ).resolves.toMatchObject({ status: "completed" });
      expect(readFileSync(absolute, "utf8")).toBe("replacement\n");
      expect(statSync(absolute).mode & 0o777).toBe(item.mode);
    }
    context.database.close();
  });

  test("a zero-progress staging write fails closed without mutating the target", async () => {
    const zeroProgressDefinition: ConnectorDefinition = {
      ...filesystemConnectorDefinition,
      executeMutation: async (input) => {
        if (input.resource.externalRef === undefined)
          throw new Error("missing test root");
        return new FilesystemSandbox(
          input.resource.externalRef,
          parseEffectiveFilesystemConstraints(input.effectiveConstraints),
          { writeStagedChunk: () => 0 },
          input.signal,
        ).executeMutation(input.operation, input.arguments, input.preconditions);
      },
    };
    const context = await fixture(new ConnectorRegistry([zeroProgressDefinition]));
    const actionRequestId = await simulate(context, "filesystem.write", {
      path: "src/index.ts",
      content: "replacement\n",
    });
    await approve(context, actionRequestId);
    await expect(
      context.execute.execute({ projectId: "project-1", actionRequestId }),
    ).resolves.toMatchObject({
      status: "failed",
      failureCode: "FilesystemWriteProgressError",
    });
    expect(readFileSync(join(context.workspace, "src", "index.ts"), "utf8"))
      .toBe("export const value = 1;\n");
    context.database.close();
  });

  test("reject is terminal and execution without an approved binding is denied", async () => {
    const context = await fixture();
    const actionRequestId = await simulate(context, "filesystem.write", {
      path: "src/index.ts",
      content: "changed\n",
    });
    await expect(
      context.execute.execute({ projectId: "project-1", actionRequestId }),
    ).rejects.toBeInstanceOf(InvalidActionApprovalStateError);
    const rejected = await context.decide.reject({
      projectId: "project-1",
      actionRequestId,
      actor: "local-user",
    });
    expect(rejected.actionStatus).toBe("rejected");
    await expect(approve(context, actionRequestId)).rejects.toBeInstanceOf(
      InvalidActionApprovalStateError,
    );
    await expect(
      context.execute.execute({ projectId: "project-1", actionRequestId }),
    ).rejects.toBeInstanceOf(InvalidActionExecutionStateError);
    expect(readFileSync(join(context.workspace, "src", "index.ts"), "utf8"))
      .toBe("export const value = 1;\n");
    context.database.close();
  });

  test("approval rejects unknown, cross-project, and duplicate decisions", async () => {
    const context = await fixture();
    const actionRequestId = await simulate(context, "filesystem.write", {
      path: "src/index.ts",
      content: "approved\n",
    });
    await expect(
      context.decide.approve({
        projectId: "project-1",
        actionRequestId: "missing-action",
        actor: "local-user",
      }),
    ).rejects.toBeInstanceOf(ActionRequestNotFoundError);
    await expect(
      context.decide.approve({
        projectId: "other-project",
        actionRequestId,
        actor: "local-user",
      }),
    ).rejects.toBeInstanceOf(CapabilityProjectMismatchError);
    await approve(context, actionRequestId);
    await expect(approve(context, actionRequestId)).rejects.toBeInstanceOf(
      InvalidActionApprovalStateError,
    );
    context.database.close();
  });

  test("SQLite enforces immutable approval binding and execution lease prerequisites", async () => {
    const context = await fixture();
    const actionRequestId = await simulate(context, "filesystem.write", {
      path: "src/index.ts",
      content: "approved\n",
    });
    const approval = await context.controlled.findApprovalByAction(
      actionRequestId,
      "project-1",
    );
    expect(() =>
      context.database
        .prepare("UPDATE action_approvals SET action_payload_hash=? WHERE id=?")
        .run("f".repeat(64), approval!.snapshot().id),
    ).toThrow("action approval binding is immutable");
    expect(() =>
      context.database
        .prepare(
          "UPDATE action_requests SET status='executing', updated_at=? WHERE id=?",
        )
        .run(context.clock.now().toISOString(), actionRequestId),
    ).toThrow("invalid action request status transition");
    expect(() =>
      context.database
        .prepare("DELETE FROM action_approvals WHERE id=?")
        .run(approval!.snapshot().id),
    ).toThrow("action approvals cannot be deleted");
    await approve(context, actionRequestId);
    const completed = await context.execute.execute({
      projectId: "project-1",
      actionRequestId,
    });
    expect(completed.status).toBe("completed");
    expect(() =>
      context.database
        .prepare(
          `INSERT INTO action_executions(
            id, project_id, action_request_id, simulation_id, approval_id,
            status, started_at
          ) SELECT 'duplicate', project_id, action_request_id, simulation_id,
            approval_id, 'executing', started_at FROM action_executions
          WHERE action_request_id=?`,
        )
        .run(actionRequestId),
    ).toThrow();
    context.database.close();
  });

  test("fresh authorization rejects revoked grants and disabled resources before I/O", async () => {
    const revoked = await fixture();
    const revokedId = await simulate(revoked, "filesystem.write", {
      path: "src/index.ts",
      content: "revoked\n",
    });
    await approve(revoked, revokedId);
    const activeGrant = (await revoked.capabilities.listGrants("project-1"))[0]!;
    await new RevokeCapabilityGrant(
      revoked.capabilities,
      revoked.audit,
      revoked.clock,
      revoked.transactions,
    ).execute({ projectId: "project-1", grantId: activeGrant.id, revokedBy: "owner" });
    await expect(
      revoked.execute.execute({ projectId: "project-1", actionRequestId: revokedId }),
    ).rejects.toBeInstanceOf(StaleActionAuthorizationError);
    expect(await revoked.controlled.findExecutionByAction(revokedId, "project-1")).toBeNull();
    expect(readFileSync(join(revoked.workspace, "src", "index.ts"), "utf8"))
      .toBe("export const value = 1;\n");
    revoked.database.close();

    const disabled = await fixture();
    const disabledId = await simulate(disabled, "filesystem.delete", { path: "src/index.ts" });
    await approve(disabled, disabledId);
    await new DisableResource(
      disabled.capabilities,
      disabled.audit,
      disabled.clock,
      disabled.transactions,
    ).execute({ projectId: "project-1", resourceId: disabled.resource.id });
    await expect(
      disabled.execute.execute({ projectId: "project-1", actionRequestId: disabledId }),
    ).rejects.toBeInstanceOf(StaleActionAuthorizationError);
    expect(readFileSync(join(disabled.workspace, "src", "index.ts"), "utf8"))
      .toBe("export const value = 1;\n");
    disabled.database.close();
  });

  test("fresh authorization rejects an expired grant and connector version mismatch", async () => {
    const expired = await fixture();
    const expiresAt = new Date(expired.clock.now().getTime() + 100);
    await grant(expired, "filesystem.write", expiresAt);
    const invoked = await expired.invoke.execute({
      projectId: "project-1",
      agentId: "agent-1",
      resourceId: expired.resource.id,
      operation: "filesystem.write",
      arguments: { path: "src/index.ts", content: "expired\n" },
    });
    await approve(expired, invoked.requestId);
    expired.clock.advance(1_000);
    await expect(
      expired.execute.execute({ projectId: "project-1", actionRequestId: invoked.requestId }),
    ).rejects.toBeInstanceOf(StaleActionAuthorizationError);
    expect(await expired.controlled.findExecutionByAction(invoked.requestId, "project-1"))
      .toBeNull();
    expired.database.close();

    const mismatch = await fixture();
    const mismatchId = await simulate(mismatch, "filesystem.write", {
      path: "src/index.ts",
      content: "mismatch\n",
    });
    await approve(mismatch, mismatchId);
    const versionThree = new ConnectorRegistry([
      {
        ...filesystemConnectorDefinition,
        descriptor: { ...filesystemConnectorDefinition.descriptor, version: "3" },
      },
    ]);
    const mismatchEvaluator = new EvaluateActionPolicy(
      mismatch.runtime,
      mismatch.capabilities,
      mismatch.clock,
      versionThree,
    );
    const mismatchExecutor = new ExecuteControlledAction(
      mismatch.capabilities,
      mismatch.controlled,
      mismatch.audit,
      mismatch.ids,
      mismatch.clock,
      mismatch.transactions,
      versionThree,
      mismatchEvaluator,
    );
    await expect(
      mismatchExecutor.execute({ projectId: "project-1", actionRequestId: mismatchId }),
    ).rejects.toThrow("Connector has no executable boundary: filesystem");
    expect(readFileSync(join(mismatch.workspace, "src", "index.ts"), "utf8"))
      .toBe("export const value = 1;\n");
    mismatch.database.close();
  });

  test("source changes, symlinks, and hard links fail before target mutation", async () => {
    for (const replacement of ["content", "symlink", "hardlink"] as const) {
      const context = await fixture();
      const actionRequestId = await simulate(context, "filesystem.write", {
        path: "src/index.ts",
        content: "approved\n",
      });
      await approve(context, actionRequestId);
      rmSync(join(context.workspace, "src", "index.ts"));
      if (replacement === "content")
        writeFileSync(join(context.workspace, "src", "index.ts"), "external\n");
      else if (replacement === "symlink")
        symlinkSync(join(context.workspace, "outside.txt"), join(context.workspace, "src", "index.ts"));
      else {
        writeFileSync(join(context.workspace, "outside.txt"), "outside\n");
        linkSync(join(context.workspace, "outside.txt"), join(context.workspace, "src", "index.ts"));
      }
      const result = await context.execute.execute({
        projectId: "project-1",
        actionRequestId,
      });
      expect(result.status).toBe("failed");
      expect((await context.controlled.findExecutionByAction(actionRequestId, "project-1"))?.snapshot().status)
        .toBe("failed");
      await expect(
        context.execute.execute({ projectId: "project-1", actionRequestId }),
      ).rejects.toBeInstanceOf(InvalidActionExecutionStateError);
      context.database.close();
    }
  });

  test("destination changes after simulation fail without overwriting", async () => {
    const create = await fixture();
    const createId = await simulate(create, "filesystem.create", {
      path: "src/new.ts",
      content: "approved\n",
    });
    await approve(create, createId);
    writeFileSync(join(create.workspace, "src", "new.ts"), "external\n");
    expect(await create.execute.execute({ projectId: "project-1", actionRequestId: createId }))
      .toMatchObject({ status: "failed" });
    expect(readFileSync(join(create.workspace, "src", "new.ts"), "utf8"))
      .toBe("external\n");
    create.database.close();

    const move = await fixture();
    const moveId = await simulate(move, "filesystem.move", {
      sourcePath: "src/index.ts",
      destinationPath: "src/moved.ts",
    });
    await approve(move, moveId);
    writeFileSync(join(move.workspace, "src", "moved.ts"), "external\n");
    expect(await move.execute.execute({ projectId: "project-1", actionRequestId: moveId }))
      .toMatchObject({ status: "failed" });
    expect(readFileSync(join(move.workspace, "src", "moved.ts"), "utf8"))
      .toBe("external\n");
    expect(readFileSync(join(move.workspace, "src", "index.ts"), "utf8"))
      .toBe("export const value = 1;\n");
    move.database.close();
  });

  test("one-shot ledger rejects concurrent and repeated execution", async () => {
    const context = await fixture();
    const actionRequestId = await simulate(context, "filesystem.create", {
      path: "src/one-shot.ts",
      content: "one\n",
    });
    await approve(context, actionRequestId);
    const outcomes = await Promise.allSettled([
      context.execute.execute({ projectId: "project-1", actionRequestId }),
      context.execute.execute({ projectId: "project-1", actionRequestId }),
    ]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((value) => value.status === "rejected")).toHaveLength(1);
    await expect(
      context.execute.execute({ projectId: "project-1", actionRequestId }),
    ).rejects.toBeInstanceOf(InvalidActionExecutionStateError);
    expect(
      context.database
        .query<{ count: number }, []>("SELECT COUNT(*) count FROM action_executions")
        .get()?.count,
    ).toBe(1);
    context.database.close();
  });

  test("post-mutation ambiguity becomes execution_unknown and is never retried", async () => {
    const ambiguousRegistry = new ConnectorRegistry([
      {
        ...filesystemConnectorDefinition,
        executeMutation: async (input) => {
          await filesystemConnectorDefinition.executeMutation!(input);
          throw new ConnectorMutationExecutionError(
            "InjectedAfterCommit",
            "mutation_may_have_occurred",
          );
        },
      },
    ]);
    const context = await fixture(ambiguousRegistry);
    const actionRequestId = await simulate(context, "filesystem.create", {
      path: "src/ambiguous.ts",
      content: "committed\n",
    });
    await approve(context, actionRequestId);
    const result = await context.execute.execute({ projectId: "project-1", actionRequestId });
    expect(result).toMatchObject({
      status: "execution_unknown",
      failureCode: "InjectedAfterCommit",
    });
    expect(readFileSync(join(context.workspace, "src", "ambiguous.ts"), "utf8"))
      .toBe("committed\n");
    await expect(
      context.execute.execute({ projectId: "project-1", actionRequestId }),
    ).rejects.toBeInstanceOf(InvalidActionExecutionStateError);
    context.database.close();
  });

  test("execution-start audit failure rolls back the lease before mutation", async () => {
    const startFailure = await fixture(
      createDefaultConnectorRegistry(),
      "action_execution_started",
    );
    const startId = await simulate(startFailure, "filesystem.create", {
      path: "src/start-failure.ts",
      content: "not-written\n",
    });
    await approve(startFailure, startId);
    await expect(
      startFailure.execute.execute({ projectId: "project-1", actionRequestId: startId }),
    ).rejects.toThrow("injected audit failure");
    expect(await startFailure.controlled.findExecutionByAction(startId, "project-1"))
      .toBeNull();
    expect((await startFailure.capabilities.findActionRequest(startId))?.snapshot().status)
      .toBe("approval_pending");
    expect(() => readFileSync(join(startFailure.workspace, "src", "start-failure.ts")))
      .toThrow();
    startFailure.database.close();
  });

  test("completion persistence failure falls back to execution_unknown", async () => {
    const outcomeFailure = await fixture(
      createDefaultConnectorRegistry(),
      "action_execution_completed",
    );
    const outcomeId = await simulate(outcomeFailure, "filesystem.create", {
      path: "src/outcome-failure.ts",
      content: "written\n",
    });
    await approve(outcomeFailure, outcomeId);
    await expect(
      outcomeFailure.execute.execute({ projectId: "project-1", actionRequestId: outcomeId }),
    ).resolves.toMatchObject({
      status: "execution_unknown",
      failureCode: "OutcomePersistenceFailed",
    });
    expect(readFileSync(join(outcomeFailure.workspace, "src", "outcome-failure.ts"), "utf8"))
      .toBe("written\n");
    expect((await outcomeFailure.capabilities.findActionRequest(outcomeId))?.snapshot().status)
      .toBe("execution_unknown");
    expect((await outcomeFailure.controlled.findExecutionByAction(outcomeId, "project-1"))?.snapshot())
      .toMatchObject({
        status: "execution_unknown",
        failureCode: "OutcomePersistenceFailed",
      });
    expect(
      outcomeFailure.database
        .query<{ event_type: string }, []>(
          "SELECT event_type FROM audit_event WHERE event_type LIKE 'action_execution_%' ORDER BY occurred_at, id",
        )
        .all()
        .map((row) => row.event_type),
    ).toEqual(["action_execution_started", "action_execution_unknown"]);
    await expect(
      outcomeFailure.execute.execute({ projectId: "project-1", actionRequestId: outcomeId }),
    ).rejects.toBeInstanceOf(InvalidActionExecutionStateError);
    outcomeFailure.database.close();
  });

  test("a failed outcome fallback leaves the one-shot execution observable as executing", async () => {
    const context = await fixture(createDefaultConnectorRegistry(), [
      "action_execution_completed",
      "action_execution_unknown",
    ]);
    const actionRequestId = await simulate(context, "filesystem.create", {
      path: "src/double-outcome-failure.ts",
      content: "written\n",
    });
    await approve(context, actionRequestId);
    await expect(
      context.execute.execute({ projectId: "project-1", actionRequestId }),
    ).rejects.toThrow("injected audit failure");
    expect(readFileSync(join(context.workspace, "src", "double-outcome-failure.ts"), "utf8"))
      .toBe("written\n");
    expect((await context.capabilities.findActionRequest(actionRequestId))?.snapshot().status)
      .toBe("executing");
    expect((await context.controlled.findExecutionByAction(actionRequestId, "project-1"))?.snapshot().status)
      .toBe("executing");
    await expect(
      context.execute.execute({ projectId: "project-1", actionRequestId }),
    ).rejects.toBeInstanceOf(InvalidActionExecutionStateError);
    context.database.close();
  });

  test("an extra current grant invalidates the approved effective authorization", async () => {
    const context = await fixture();
    const actionRequestId = await simulate(context, "filesystem.write", {
      path: "src/index.ts",
      content: "approved\n",
    });
    await approve(context, actionRequestId);
    await grant(context, "filesystem.write");
    await expect(
      context.execute.execute({ projectId: "project-1", actionRequestId }),
    ).rejects.toBeInstanceOf(StaleActionAuthorizationError);
    expect(await context.controlled.findExecutionByAction(actionRequestId, "project-1"))
      .toBeNull();
    context.database.close();
  });
});
