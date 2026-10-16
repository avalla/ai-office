import {
  PipelineRun,
  type PipelineOverrideRecord,
} from "@ai-office/domain/pipeline/pipeline-run.ts";
import type { OfficePipeline } from "@ai-office/domain/office/office-manifest.ts";
import type { ReadProjectConfiguration } from "../domain-pack/read-project-configuration.ts";
import type { ResolvedProjectConfiguration } from "../domain-pack/resolve-project-configuration.ts";
import {
  findPackWorkflow,
  isDependencyOnlyWorkflow,
  localDefinitionId,
  packWorkflowPipeline,
} from "./pack-pipeline-definition.ts";
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
import type { JobOutboxRepository } from "../ports/job-outbox-repository.port.ts";
import type { TaskDependencyRepository } from "../ports/task-dependency-repository.port.ts";
import { assertTaskPrerequisitesComplete } from "../commands/manage-task-dependencies.ts";
import type {
  AgentExecutionPrincipal,
  OperatorPrincipal,
} from "../ports/execution-principal.port.ts";
import { RecordAuditEvent } from "../commands/record-audit-event.ts";
import {
  ActivePipelineRunExistsError,
  ConcurrentPipelineTransitionError,
  PipelineActorUnauthorizedError,
  PipelineDefinitionAmbiguousError,
  PipelineDefinitionNotEnforcedError,
  PackPipelineUnsupportedError,
  PipelineRoleUnavailableError,
  PipelineRunNotFoundError,
} from "../pipeline-errors.ts";

type PipelinePrincipal = OperatorPrincipal | AgentExecutionPrincipal;

/**
 * Provenance for a stage completion that resumes a suspended pipeline: which
 * trigger drove the recovery, and — for a task completion — which task did.
 */
export interface PipelineResumption {
  readonly trigger: "task_completion" | "tick" | "orchestration_replay";
  readonly triggerTaskId?: string;
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
    private readonly outbox?: JobOutboxRepository,
    private readonly taskDependencies?: TaskDependencyRepository,
    /**
     * M16.5 Runtime activation: when present, a new run's configuration pin
     * is read from here, and a project with a nonempty pack selection may
     * start a run from a resolved pack workflow instead of a manifest
     * pipeline (see `selectDefinition`). A project with an empty selection
     * is untouched.
     */
    private readonly configuration?: ReadProjectConfiguration,
  ) {}

  async start(input: {
    projectId: string;
    taskId: string;
    pipelineId: string;
    /** Chooses the source when a pipeline ID names both; otherwise optional. */
    source?: "manifest" | "pack";
    principal: OperatorPrincipal;
    actorLabel?: string;
  }): Promise<PipelineRun> {
    this.requireOperator(input.principal);
    const task = await this.tasks.findById(input.taskId);
    if (task === null || task.snapshot().projectId !== input.projectId)
      throw new TaskNotFoundError(input.taskId);
    if (this.taskDependencies !== undefined)
      await assertTaskPrerequisitesComplete(
        input.projectId,
        input.taskId,
        this.tasks,
        this.taskDependencies,
      );
    if (
      (await this.pipelines.findActiveByTask(input.taskId, input.projectId)) !==
      null
    )
      throw new ActivePipelineRunExistsError(input.taskId);
    const revision = await this.manifests.findLatest(input.projectId);
    if (revision === null)
      throw new OfficeManifestNotFoundError(input.projectId);
    const manifestDefinition = revision.manifest.pipelines.find(
      (value) => value.id === input.pipelineId,
    );
    // A project with no selected pack has only manifest pipelines: refuse an
    // unknown or guidance pipeline before any write lock or configuration
    // read, in the order this command always had. The decision is made again
    // inside the transaction, where the selection is authoritative.
    if (
      input.source !== "pack" &&
      (this.configuration === undefined ||
        !(await this.configuration.selectsPacks(input.projectId)))
    ) {
      if (manifestDefinition === undefined)
        throw new OfficePipelineNotFoundError(
          input.projectId,
          input.pipelineId,
        );
      if (manifestDefinition.enforcement !== "enforced")
        throw new PipelineDefinitionNotEnforcedError(manifestDefinition.id);
    }
    const run = await this.transactions.run(async () => {
      if (this.taskDependencies !== undefined)
        await assertTaskPrerequisitesComplete(
          input.projectId,
          input.taskId,
          this.tasks,
          this.taskDependencies,
        );
      // Resolved inside this same authoritative transaction so the pin and
      // the selected definition reflect the binding/definition revisions as
      // of the run insertion below, not a possibly-stale snapshot read before
      // the transaction opened (an immutable historical pin cannot be
      // revalidated later).
      const now = this.clock.now();
      const configuration = await this.readActiveConfiguration(input.projectId);
      const selected = await this.selectDefinition({
        projectId: input.projectId,
        pipelineId: input.pipelineId,
        manifestDefinition,
        configuration,
        ...(input.source === undefined ? {} : { source: input.source }),
      });
      const definition = selected.definition;
      const stageRunIds = definition.stages.map(() => this.ids.generate());
      const runId = this.ids.generate();
      const configurationPin = configuration?.pin;
      const run = PipelineRun.create({
        id: runId,
        projectId: input.projectId,
        taskId: input.taskId,
        manifestRevisionId: revision.id,
        manifestRevision: revision.revision,
        definition,
        startedBy: input.principal.id,
        stageRunIds,
        ...(configurationPin === undefined ? {} : { configurationPin }),
        now,
      });
      task.start(now);
      await this.tasks.save(task);
      await this.pipelines.insert(run);
      await this.event(run, "pipeline.started", input.principal, {
        taskId: input.taskId,
        pipelineId: definition.id,
        manifestRevision: revision.revision,
        ...(selected.source === "pack"
          ? {
              definitionSource: "pack",
              workflowId: selected.workflowId,
            }
          : {}),
        ...(input.actorLabel === undefined
          ? {}
          : { actorLabel: input.actorLabel }),
      });
      await this.event(run, "pipeline.stage_activated", input.principal, {
        stageId: run.currentStage()!.stageId,
      });
      await this.enqueueCurrentStage(run);
      return run;
    });
    return run;
  }

  async assign(input: {
    projectId: string;
    pipelineRunId: string;
    agentId: string;
    principal: OperatorPrincipal;
    actorLabel?: string;
  }): Promise<PipelineRun> {
    this.requireOperator(input.principal);
    const agent = await this.agents.findAgent(input.agentId);
    if (agent === null || agent.projectId !== input.projectId || !agent.enabled)
      throw new AgentNotFoundError(input.agentId);
    const role = await this.agents.findRole(agent.roleId, input.projectId);
    if (role === null) throw new AgentNotFoundError(input.agentId);
    return this.change(input.projectId, input.pipelineRunId, async (run) => {
      const before = run.snapshot().version;
      run.assign(input.agentId, role.snapshot().key, this.clock.now());
      await this.persist(run, before);
      await this.event(run, "pipeline.agent_assigned", input.principal, {
        stageId: run.currentStage()!.stageId,
        agentId: input.agentId,
        ...(input.actorLabel === undefined
          ? {}
          : { actorLabel: input.actorLabel }),
      });
    });
  }

  async completeStageFromAgentRun(input: {
    projectId: string;
    agentRunId: string;
    expectedPipelineRunId?: string;
    resumption?: PipelineResumption;
  }): Promise<PipelineRun> {
    const agentRun = await this.agents.findRun(input.agentRunId);
    if (agentRun === null)
      throw new PipelineActorUnauthorizedError("stage completion");
    const agent = agentRun.snapshot();
    if (
      agent.projectId !== input.projectId ||
      agent.pipelineRunId === undefined
    )
      throw new PipelineActorUnauthorizedError("stage completion");
    if (
      input.expectedPipelineRunId !== undefined &&
      input.expectedPipelineRunId !== agent.pipelineRunId
    )
      throw new PipelineActorUnauthorizedError("stage completion");
    if (agent.pipelineStageRunId === undefined)
      throw new PipelineActorUnauthorizedError("stage completion");
    if (!(
      agent.status === "completed" ||
      agent.status === "running" ||
      agent.status === "reviewing"
    ))
      throw new PipelineActorUnauthorizedError("stage completion");
    const principal: AgentExecutionPrincipal = {
      kind: "agent",
      agentRunId: agent.id,
      agentId: agent.agentId,
      projectId: agent.projectId,
      taskId: agent.taskId,
      pipelineRunId: agent.pipelineRunId,
      pipelineStageRunId: agent.pipelineStageRunId,
    };
    return this.change(input.projectId, agent.pipelineRunId, async (run) => {
      const snapshot = run.snapshot();
      const stage = run.currentStage();
      if (
        snapshot.taskId !== principal.taskId ||
        stage === null ||
        stage.id !== principal.pipelineStageRunId
      )
        throw new PipelineActorUnauthorizedError("stage completion");
      const assignedAgent = await this.agents.findAgent(principal.agentId);
      const assignedRole =
        assignedAgent === null
          ? null
          : await this.agents.findRole(assignedAgent.roleId, input.projectId);
      if (
        assignedAgent === null ||
        assignedAgent.projectId !== input.projectId ||
        assignedRole === null ||
        assignedRole.snapshot().key !== stage.roleId ||
        stage.status !== "active" ||
        stage.assignedAgentId !== principal.agentId
      )
        throw new PipelineActorUnauthorizedError("stage completion");
      const before = run.snapshot();
      run.completeStage(principal.agentId, this.clock.now());
      await this.persist(run, before.version);
      await this.syncTaskTerminal(run);
      const after = run.snapshot();
      if (input.resumption !== undefined) {
        // The resume and the stage completion it unlocked are the same state
        // transition, so their audit records commit in this transaction. The
        // prerequisite list is read here, authoritatively, not trusted from
        // the caller.
        const prerequisiteTaskIds =
          this.taskDependencies === undefined
            ? []
            : (await this.taskDependencies.listByProject(input.projectId))
                .filter((edge) => edge.taskId === before.taskId)
                .map((edge) => edge.dependsOnTaskId)
                .sort();
        await this.event(run, "pipeline.resumed", principal, {
          stageId: before.stages[before.currentStageIndex]!.stageId,
          agentRunId: agent.id,
          trigger: input.resumption.trigger,
          ...(input.resumption.triggerTaskId === undefined
            ? {}
            : { triggerTaskId: input.resumption.triggerTaskId }),
          prerequisiteTaskIds,
        });
      }
      await this.event(
        run,
        run.currentStage()?.status === "awaiting_approval"
          ? "pipeline.approval_requested"
          : "pipeline.stage_completed",
        principal,
        { stageId: before.stages[before.currentStageIndex]!.stageId },
      );
      if (after.status === "completed")
        await this.event(run, "pipeline.completed", principal, {});
      else if (after.currentStageIndex !== before.currentStageIndex)
        await this.event(run, "pipeline.stage_activated", principal, {
          stageId: after.stages[after.currentStageIndex]!.stageId,
        });
      if (
        after.status === "active" &&
        after.currentStageIndex !== before.currentStageIndex
      )
        await this.enqueueCurrentStage(run);
    });
  }

  async approveStage(input: {
    projectId: string;
    pipelineRunId: string;
    principal: OperatorPrincipal;
    actorLabel?: string;
    rationale?: string;
  }): Promise<PipelineRun> {
    this.requireOperator(input.principal);
    return this.change(input.projectId, input.pipelineRunId, async (run) => {
      const before = run.snapshot();
      run.approveStage(input.principal.id, input.rationale, this.clock.now());
      await this.persist(run, before.version);
      await this.syncTaskTerminal(run);
      await this.event(run, "pipeline.approval_granted", input.principal, {
        stageId: before.stages[before.currentStageIndex]!.stageId,
        ...(input.actorLabel === undefined
          ? {}
          : { actorLabel: input.actorLabel }),
        ...(input.rationale === undefined
          ? {}
          : { rationale: input.rationale }),
      });
      await this.afterAdvance(run, before, input.principal);
    });
  }

  async rejectStage(input: {
    projectId: string;
    pipelineRunId: string;
    principal: OperatorPrincipal;
    actorLabel?: string;
    rationale: string;
  }): Promise<PipelineRun> {
    this.requireOperator(input.principal);
    return this.change(input.projectId, input.pipelineRunId, async (run) => {
      const before = run.snapshot();
      run.rejectStage(input.principal.id, input.rationale, this.clock.now());
      await this.persist(run, before.version);
      await this.syncTaskTerminal(run);
      await this.event(run, "pipeline.approval_rejected", input.principal, {
        stageId: before.stages[before.currentStageIndex]!.stageId,
        rationale: input.rationale,
        ...(input.actorLabel === undefined
          ? {}
          : { actorLabel: input.actorLabel }),
      });
      await this.event(run, "pipeline.cancelled", input.principal, {
        reason: "approval_rejected",
      });
    });
  }

  async override(input: {
    projectId: string;
    pipelineRunId: string;
    principal: OperatorPrincipal;
    actorLabel?: string;
    reason: string;
  }): Promise<{ run: PipelineRun; override: PipelineOverrideRecord }> {
    this.requireOperator(input.principal);
    let result: PipelineOverrideRecord | undefined;
    const run = await this.change(
      input.projectId,
      input.pipelineRunId,
      async (value) => {
        const before = value.snapshot();
        result = value.overrideCurrent({
          id: this.ids.generate(),
          actorId: input.principal.id,
          reason: input.reason,
          now: this.clock.now(),
        });
        await this.persist(value, before.version);
        await this.syncTaskTerminal(value);
        await this.pipelines.appendOverride(result);
        await this.event(value, "pipeline.override_issued", input.principal, {
          stageId: before.stages[before.currentStageIndex]!.stageId,
          reason: result.reason,
          previousRule: result.previousRule,
          resultingAuthorization: result.resultingAuthorization,
          ...(input.actorLabel === undefined
            ? {}
            : { actorLabel: input.actorLabel }),
        });
        await this.afterAdvance(value, before, input.principal);
      },
    );
    return { run, override: result! };
  }

  async cancel(input: {
    projectId: string;
    pipelineRunId: string;
    principal: OperatorPrincipal;
    actorLabel?: string;
  }): Promise<PipelineRun> {
    this.requireOperator(input.principal);
    return this.change(input.projectId, input.pipelineRunId, async (run) => {
      const version = run.snapshot().version;
      run.cancel(input.principal.id, this.clock.now());
      await this.persist(run, version);
      await this.syncTaskTerminal(run);
      await this.event(run, "pipeline.cancelled", input.principal, {
        ...(input.actorLabel === undefined
          ? {}
          : { actorLabel: input.actorLabel }),
      });
    });
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

  /**
   * The resolved configuration of a project that selected at least one pack,
   * read inside the active transaction; `undefined` for every other project,
   * which keeps manifest selection and no pin. Must be called from inside
   * `this.transactions.run(...)`: it reads through the open transaction, so
   * the pin and the selected definition reflect the binding and definition
   * revisions exactly as of the run insertion that follows.
   */
  private async readActiveConfiguration(
    projectId: string,
  ): Promise<ResolvedProjectConfiguration | undefined> {
    if (this.configuration === undefined) return undefined;
    const configuration =
      await this.configuration.readPinWithinActiveTransaction(projectId);
    return configuration.selectedPacks.length === 0 ? undefined : configuration;
  }

  /**
   * Which definition a new run freezes. A pack workflow is eligible only for
   * a project with a nonempty pack selection. An ID that names both a
   * manifest pipeline and a pack workflow needs an explicit `source`. A workflow
   * of a dependency pack the project did not select is never startable. A pack
   * workflow fails closed unless every stage role already exists in the
   * Runtime: activation materializes no role or agent. A guidance definition,
   * from either source, is refused here, before any role is demanded.
   */
  private async selectDefinition(input: {
    projectId: string;
    pipelineId: string;
    manifestDefinition: OfficePipeline | undefined;
    configuration: ResolvedProjectConfiguration | undefined;
    source?: "manifest" | "pack";
  }): Promise<
    | { definition: OfficePipeline; source: "manifest" }
    | { definition: OfficePipeline; source: "pack"; workflowId: string }
  > {
    const configuration = input.configuration;
    const workflow =
      configuration === undefined || input.source === "manifest"
        ? undefined
        : findPackWorkflow(configuration, input.pipelineId);
    const manifestDefinition =
      input.source === "pack" ? undefined : input.manifestDefinition;
    if (workflow !== undefined && manifestDefinition !== undefined)
      throw new PipelineDefinitionAmbiguousError(input.pipelineId);
    if (configuration === undefined || workflow === undefined) {
      if (
        manifestDefinition === undefined &&
        configuration !== undefined &&
        input.source !== "manifest" &&
        isDependencyOnlyWorkflow(configuration, input.pipelineId)
      )
        throw new PackPipelineUnsupportedError(
          input.pipelineId,
          "it belongs to a dependency pack the project did not select",
        );
      if (manifestDefinition === undefined)
        throw new OfficePipelineNotFoundError(
          input.projectId,
          input.pipelineId,
        );
      if (manifestDefinition.enforcement !== "enforced")
        throw new PipelineDefinitionNotEnforcedError(manifestDefinition.id);
      return { definition: manifestDefinition, source: "manifest" };
    }
    const definition = packWorkflowPipeline(configuration, workflow);
    // A guidance workflow is refused as such before any role is demanded.
    if (definition.enforcement !== "enforced")
      throw new PipelineDefinitionNotEnforcedError(definition.id);
    const known = new Set(
      (await this.agents.listRoles(input.projectId)).map(
        (role) => role.snapshot().key,
      ),
    );
    const missing = [
      ...new Set(
        definition.stages
          .map((stage) => stage.roleId)
          .filter((roleId) => !known.has(roleId)),
      ),
    ];
    if (missing.length > 0)
      throw new PipelineRoleUnavailableError(
        localDefinitionId(workflow.workflowId),
        missing,
      );
    return { definition, source: "pack", workflowId: workflow.workflowId };
  }

  private requireOperator(actor: OperatorPrincipal): void {
    if (
      actor.kind !== "operator" ||
      actor.source !== "local_cli" ||
      actor.id !== "local-operator"
    )
      throw new PipelineActorUnauthorizedError("administration");
  }

  private async afterAdvance(
    run: PipelineRun,
    before: ReturnType<PipelineRun["snapshot"]>,
    actor: PipelinePrincipal,
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
    if (after.status === "active") await this.enqueueCurrentStage(run);
  }

  private async enqueueCurrentStage(run: PipelineRun): Promise<void> {
    const stage = run.currentStage();
    if (
      this.outbox === undefined ||
      stage === null ||
      stage.status !== "active"
    )
      return;
    const snapshot = run.snapshot();
    const now = this.clock.now();
    await this.outbox.append({
      id: `outbox:pipeline:${snapshot.id}:${stage.id}:${snapshot.version}`,
      projectId: snapshot.projectId,
      jobType: "orchestrate_pipeline",
      aggregateType: "pipeline_run",
      aggregateId: snapshot.id,
      pipelineStageRunId: stage.id,
      dedupeKey: `pipeline:${snapshot.id}:stage:${stage.id}:v${snapshot.version}`,
      payload: {
        projectId: snapshot.projectId,
        pipelineRunId: snapshot.id,
        pipelineStageRunId: stage.id,
      },
      availableAt: now,
      createdAt: now,
    });
  }

  private async syncTaskTerminal(run: PipelineRun): Promise<void> {
    const snapshot = run.snapshot();
    if (snapshot.status === "active") return;
    const task = await this.tasks.findById(snapshot.taskId);
    if (task === null || task.snapshot().projectId !== snapshot.projectId)
      throw new TaskNotFoundError(snapshot.taskId);
    if (snapshot.status === "completed") {
      // The pipeline cannot finish work whose prerequisites are still in review.
      if (this.taskDependencies !== undefined)
        await assertTaskPrerequisitesComplete(
          snapshot.projectId,
          snapshot.taskId,
          this.tasks,
          this.taskDependencies,
          "completion",
        );
      task.complete(this.clock.now());
    } else task.cancel(this.clock.now());
    await this.tasks.save(task);
  }

  private async event(
    run: PipelineRun,
    eventType: string,
    actor: PipelinePrincipal,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const snapshot = run.snapshot();
    await this.audit.execute({
      eventType,
      actorType: actor.kind === "operator" ? "cli" : "system",
      actorId: actor.kind === "operator" ? actor.id : actor.agentId,
      projectId: snapshot.projectId,
      aggregateType: "pipeline_run",
      aggregateId: snapshot.id,
      payload,
    });
  }
}
