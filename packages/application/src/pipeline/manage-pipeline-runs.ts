import {
  PipelineRun,
  type PipelineOverrideRecord,
} from "@ai-office/domain/pipeline/pipeline-run.ts";
import {
  OfficeManifestNotFoundError,
  OfficePipelineNotFoundError,
} from "../errors.ts";
import {
  AgentNotFoundError,
  TaskNotFoundError,
} from "../commands/schedule-agent-run.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { OfficeManifestRepository } from "../ports/office-manifest-repository.port.ts";
import type { PipelineRunRepository } from "../ports/pipeline-run-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import { RecordAuditEvent } from "../commands/record-audit-event.ts";
import {
  ActivePipelineRunExistsError,
  ConcurrentPipelineTransitionError,
  PipelineActorUnauthorizedError,
  PipelineDefinitionNotEnforcedError,
  PipelineRunNotFoundError,
} from "../pipeline-errors.ts";

export interface PipelineActor {
  type: "user" | "agent";
  id: string;
}

export class ManagePipelineRuns {
  constructor(
    private readonly manifests: OfficeManifestRepository,
    private readonly pipelines: PipelineRunRepository,
    private readonly tasks: TaskRepository,
    private readonly agents: AgentRuntimeRepository,
    private readonly audit: RecordAuditEvent,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}

  async start(input: {
    projectId: string;
    taskId: string;
    pipelineId: string;
    actor: PipelineActor;
  }): Promise<PipelineRun> {
    this.requireOperator(input.actor);
    const task = await this.tasks.findById(input.taskId);
    if (task === null || task.snapshot().projectId !== input.projectId)
      throw new TaskNotFoundError(input.taskId);
    if (
      (await this.pipelines.findActiveByTask(input.taskId, input.projectId)) !==
      null
    )
      throw new ActivePipelineRunExistsError(input.taskId);
    const revision = await this.manifests.findLatest(input.projectId);
    if (revision === null)
      throw new OfficeManifestNotFoundError(input.projectId);
    const definition = revision.manifest.pipelines.find(
      (value) => value.id === input.pipelineId,
    );
    if (definition === undefined)
      throw new OfficePipelineNotFoundError(input.projectId, input.pipelineId);
    if (definition.enforcement !== "enforced")
      throw new PipelineDefinitionNotEnforcedError(definition.id);
    const now = this.clock.now();
    const run = PipelineRun.create({
      id: this.ids.generate(),
      projectId: input.projectId,
      taskId: input.taskId,
      manifestRevisionId: revision.id,
      manifestRevision: revision.revision,
      definition,
      startedBy: input.actor.id,
      stageRunIds: definition.stages.map(() => this.ids.generate()),
      now,
    });
    task.start(now);
    await this.transactions.run(async () => {
      await this.tasks.save(task);
      await this.pipelines.insert(run);
      await this.event(run, "pipeline.started", input.actor, {
        taskId: input.taskId,
        pipelineId: definition.id,
        manifestRevision: revision.revision,
      });
      await this.event(run, "pipeline.stage_activated", input.actor, {
        stageId: run.currentStage()!.stageId,
      });
    });
    return run;
  }

  async assign(input: {
    projectId: string;
    pipelineRunId: string;
    agentId: string;
    actor: PipelineActor;
  }): Promise<PipelineRun> {
    this.requireOperator(input.actor);
    const agent = await this.agents.findAgent(input.agentId);
    if (agent === null || agent.projectId !== input.projectId || !agent.enabled)
      throw new AgentNotFoundError(input.agentId);
    const role = await this.agents.findRole(agent.roleId, input.projectId);
    if (role === null) throw new AgentNotFoundError(input.agentId);
    return this.change(
      input.projectId,
      input.pipelineRunId,
      input.actor,
      async (run) => {
        const before = run.snapshot().version;
        run.assign(input.agentId, role.snapshot().key, this.clock.now());
        await this.persist(run, before);
        await this.event(run, "pipeline.agent_assigned", input.actor, {
          stageId: run.currentStage()!.stageId,
          agentId: input.agentId,
        });
      },
    );
  }

  async completeStage(input: {
    projectId: string;
    pipelineRunId: string;
    actor: PipelineActor;
  }): Promise<PipelineRun> {
    if (input.actor.type !== "agent")
      throw new PipelineActorUnauthorizedError("stage completion");
    return this.change(
      input.projectId,
      input.pipelineRunId,
      input.actor,
      async (run) => {
        const before = run.snapshot();
        run.completeStage(input.actor.id, this.clock.now());
        await this.persist(run, before.version);
        await this.syncTaskTerminal(run);
        const after = run.snapshot();
        await this.event(
          run,
          run.currentStage()?.status === "awaiting_approval"
            ? "pipeline.approval_requested"
            : "pipeline.stage_completed",
          input.actor,
          { stageId: before.stages[before.currentStageIndex]!.stageId },
        );
        if (after.status === "completed")
          await this.event(run, "pipeline.completed", input.actor, {});
        else if (after.currentStageIndex !== before.currentStageIndex)
          await this.event(run, "pipeline.stage_activated", input.actor, {
            stageId: after.stages[after.currentStageIndex]!.stageId,
          });
      },
    );
  }

  async approveStage(input: {
    projectId: string;
    pipelineRunId: string;
    actor: PipelineActor;
    rationale?: string;
  }): Promise<PipelineRun> {
    this.requireOperator(input.actor);
    return this.change(
      input.projectId,
      input.pipelineRunId,
      input.actor,
      async (run) => {
        const before = run.snapshot();
        run.approveStage(input.actor.id, input.rationale, this.clock.now());
        await this.persist(run, before.version);
        await this.syncTaskTerminal(run);
        await this.event(run, "pipeline.approval_granted", input.actor, {
          stageId: before.stages[before.currentStageIndex]!.stageId,
          ...(input.rationale === undefined
            ? {}
            : { rationale: input.rationale }),
        });
        await this.afterAdvance(run, before, input.actor);
      },
    );
  }

  async rejectStage(input: {
    projectId: string;
    pipelineRunId: string;
    actor: PipelineActor;
    rationale: string;
  }): Promise<PipelineRun> {
    this.requireOperator(input.actor);
    return this.change(
      input.projectId,
      input.pipelineRunId,
      input.actor,
      async (run) => {
        const before = run.snapshot();
        run.rejectStage(input.actor.id, input.rationale, this.clock.now());
        await this.persist(run, before.version);
        await this.syncTaskTerminal(run);
        await this.event(run, "pipeline.approval_rejected", input.actor, {
          stageId: before.stages[before.currentStageIndex]!.stageId,
          rationale: input.rationale,
        });
        await this.event(run, "pipeline.cancelled", input.actor, {
          reason: "approval_rejected",
        });
      },
    );
  }

  async override(input: {
    projectId: string;
    pipelineRunId: string;
    actor: PipelineActor;
    reason: string;
  }): Promise<{ run: PipelineRun; override: PipelineOverrideRecord }> {
    this.requireOperator(input.actor);
    let result: PipelineOverrideRecord | undefined;
    const run = await this.change(
      input.projectId,
      input.pipelineRunId,
      input.actor,
      async (value) => {
        const before = value.snapshot();
        result = value.overrideCurrent({
          id: this.ids.generate(),
          actorId: input.actor.id,
          reason: input.reason,
          now: this.clock.now(),
        });
        await this.persist(value, before.version);
        await this.syncTaskTerminal(value);
        await this.pipelines.appendOverride(result);
        await this.event(value, "pipeline.override_issued", input.actor, {
          stageId: before.stages[before.currentStageIndex]!.stageId,
          reason: result.reason,
          previousRule: result.previousRule,
          resultingAuthorization: result.resultingAuthorization,
        });
        await this.afterAdvance(value, before, input.actor);
      },
    );
    return { run, override: result! };
  }

  async cancel(input: {
    projectId: string;
    pipelineRunId: string;
    actor: PipelineActor;
  }): Promise<PipelineRun> {
    this.requireOperator(input.actor);
    return this.change(
      input.projectId,
      input.pipelineRunId,
      input.actor,
      async (run) => {
        const version = run.snapshot().version;
        run.cancel(input.actor.id, this.clock.now());
        await this.persist(run, version);
        await this.syncTaskTerminal(run);
        await this.event(run, "pipeline.cancelled", input.actor, {});
      },
    );
  }

  async show(projectId: string, pipelineRunId: string): Promise<PipelineRun> {
    return this.requireRun(pipelineRunId, projectId);
  }

  async list(projectId: string): Promise<PipelineRun[]> {
    return this.pipelines.listByProject(projectId);
  }

  private async change(
    projectId: string,
    pipelineRunId: string,
    _actor: PipelineActor,
    operation: (run: PipelineRun) => Promise<void>,
  ): Promise<PipelineRun> {
    return this.transactions.run(async () => {
      const run = await this.requireRun(pipelineRunId, projectId);
      await operation(run);
      return run;
    });
  }

  private async requireRun(
    id: string,
    projectId: string,
  ): Promise<PipelineRun> {
    const run = await this.pipelines.findById(id, projectId);
    if (run === null) throw new PipelineRunNotFoundError(id);
    return run;
  }

  private async persist(
    run: PipelineRun,
    expectedVersion: number,
  ): Promise<void> {
    if (!(await this.pipelines.save(run, expectedVersion)))
      throw new ConcurrentPipelineTransitionError(run.snapshot().id);
  }

  private requireOperator(actor: PipelineActor): void {
    if (actor.type !== "user")
      throw new PipelineActorUnauthorizedError("administration");
    if (actor.id.trim() === "")
      throw new PipelineActorUnauthorizedError("administration");
  }

  private async afterAdvance(
    run: PipelineRun,
    before: ReturnType<PipelineRun["snapshot"]>,
    actor: PipelineActor,
  ): Promise<void> {
    const after = run.snapshot();
    await this.event(run, "pipeline.stage_completed", actor, {
      stageId: before.stages[before.currentStageIndex]!.stageId,
    });
    if (after.status === "completed")
      await this.event(run, "pipeline.completed", actor, {});
    else
      await this.event(run, "pipeline.stage_activated", actor, {
        stageId: after.stages[after.currentStageIndex]!.stageId,
      });
  }

  private async syncTaskTerminal(run: PipelineRun): Promise<void> {
    const snapshot = run.snapshot();
    if (snapshot.status === "active") return;
    const task = await this.tasks.findById(snapshot.taskId);
    if (task === null || task.snapshot().projectId !== snapshot.projectId)
      throw new TaskNotFoundError(snapshot.taskId);
    if (snapshot.status === "completed") task.complete(this.clock.now());
    else task.cancel(this.clock.now());
    await this.tasks.save(task);
  }

  private async event(
    run: PipelineRun,
    eventType: string,
    actor: PipelineActor,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const snapshot = run.snapshot();
    await this.audit.execute({
      eventType,
      actorType: actor.type === "user" ? "cli" : "system",
      actorId: actor.id,
      projectId: snapshot.projectId,
      aggregateType: "pipeline_run",
      aggregateId: snapshot.id,
      payload,
    });
  }
}
