import { createHash } from "node:crypto";
import {
  canonicalStringify,
  normalizeCanonicalJson,
} from "@ai-office/domain/capability/canonical-json.ts";
import {
  assertKnowledgeIdentifier,
  type DecisionInput,
  type KnowledgeProvenance,
  type MemoryInput,
  type RuntimeAgentKnowledge,
} from "../ports/agent-knowledge-store.port.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { RepositoryIdentityRepository } from "../ports/repository-identity-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type { RecordAuditEvent } from "../commands/record-audit-event.ts";

export type KnowledgeAdmissionKind = "memory" | "decision";

export type KnowledgeAdmissionErrorCode =
  | "KNOWLEDGE_INVALID_KIND"
  | "KNOWLEDGE_INVALID_TEXT"
  | "KNOWLEDGE_INVALID_TITLE"
  | "KNOWLEDGE_PROVENANCE_UNAVAILABLE"
  | "KNOWLEDGE_RUN_NOT_COMPLETED"
  | "KNOWLEDGE_APPROVAL_MISMATCH"
  | "KNOWLEDGE_ADMISSION_FAILED"
  | "KNOWLEDGE_APPROVAL_AUDIT_FAILED"
  | "KNOWLEDGE_ADMISSION_OUTCOME_UNKNOWN"
  | "KNOWLEDGE_ADMISSION_RECONCILIATION_REQUIRED"
  | "KNOWLEDGE_ADMISSION_CONFLICT"
  | "KNOWLEDGE_INVALID_PROVENANCE"
  | "KNOWLEDGE_PROJECT_NOT_FOUND"
  | "KNOWLEDGE_STORE_NOT_CONNECTED";

export class KnowledgeAdmissionError extends Error {
  constructor(readonly code: KnowledgeAdmissionErrorCode) {
    super(code);
    this.name = "KnowledgeAdmissionError";
  }
}

export interface KnowledgeAdmissionPlan {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly kind: KnowledgeAdmissionKind;
  readonly id: string;
  readonly title: string | null;
  readonly text: string;
  readonly source: {
    readonly kind: "run";
    readonly id: string;
    readonly label: string;
    readonly locator: string;
  };
  readonly createdAt: string;
  readonly planHash: string;
}

export interface KnowledgeAdmissionResult extends KnowledgeAdmissionPlan {
  readonly outcome: "recorded" | "reconciled";
}

/** New knowledge is admitted only from a completed, authoritative run and an exact operator-reviewed plan. */
export class ManageKnowledgeAdmission {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly tasks: TaskRepository,
    private readonly runtime: AgentRuntimeRepository,
    private readonly identities: RepositoryIdentityRepository,
    private readonly knowledge: RuntimeAgentKnowledge,
    private readonly audit: RecordAuditEvent,
    private readonly clock: Clock,
  ) {}

  async plan(input: {
    projectId: string;
    runId: string;
    kind: KnowledgeAdmissionKind;
    title?: string;
    text: string;
  }): Promise<KnowledgeAdmissionPlan> {
    const state = this.connected();
    assertKnowledgeIdentifier(input.projectId);
    assertKnowledgeIdentifier(input.runId);
    if (input.kind !== "memory" && input.kind !== "decision") {
      throw new KnowledgeAdmissionError("KNOWLEDGE_INVALID_KIND");
    }
    if (
      typeof input.text !== "string" ||
      input.text.trim() !== input.text ||
      input.text.length === 0 ||
      [...input.text].length > 4_000 ||
      Buffer.byteLength(input.text, "utf8") > 16_384
    ) {
      throw new KnowledgeAdmissionError("KNOWLEDGE_INVALID_TEXT");
    }
    if (
      input.kind === "decision" &&
      (typeof input.title !== "string" ||
        input.title.trim() !== input.title ||
        input.title.length === 0 ||
        [...input.title].length > 200)
    ) {
      throw new KnowledgeAdmissionError("KNOWLEDGE_INVALID_TITLE");
    }
    if (input.kind === "memory" && input.title !== undefined) {
      throw new KnowledgeAdmissionError("KNOWLEDGE_INVALID_TITLE");
    }
    const [project, run, repositoryId] = await Promise.all([
      this.projects.findById(input.projectId),
      this.runtime.findRun(input.runId),
      this.identities.findRepositoryId(input.projectId),
    ]);
    if (project === null || repositoryId === null || run === null) {
      throw new KnowledgeAdmissionError("KNOWLEDGE_PROVENANCE_UNAVAILABLE");
    }
    assertKnowledgeIdentifier(repositoryId);
    const snapshot = run.snapshot();
    if (
      snapshot.projectId !== input.projectId ||
      snapshot.status !== "completed" ||
      snapshot.completedAt === undefined ||
      snapshot.execution?.kind !== "worker" ||
      snapshot.result === undefined
    ) {
      throw new KnowledgeAdmissionError("KNOWLEDGE_RUN_NOT_COMPLETED");
    }
    const [task, agent] = await Promise.all([
      this.tasks.findById(snapshot.taskId),
      this.runtime.findAgent(snapshot.agentId),
    ]);
    if (
      task?.snapshot().projectId !== input.projectId ||
      agent?.projectId !== input.projectId
    ) {
      throw new KnowledgeAdmissionError("KNOWLEDGE_PROVENANCE_UNAVAILABLE");
    }
    let resultDigest: string;
    try {
      resultDigest = createHash("sha256")
        .update(
          canonicalStringify(normalizeCanonicalJson(snapshot.result)),
          "utf8",
        )
        .digest("hex");
    } catch {
      throw new KnowledgeAdmissionError("KNOWLEDGE_PROVENANCE_UNAVAILABLE");
    }
    const proposal = {
      schemaVersion: 1 as const,
      projectId: input.projectId,
      repositoryId,
      runId: snapshot.id,
      taskId: snapshot.taskId,
      agentId: snapshot.agentId,
      kind: input.kind,
      title: input.kind === "decision" ? input.title! : null,
      text: input.text,
      source: {
        kind: "run" as const,
        id: snapshot.id,
        label: `Agent run ${snapshot.id}`,
        locator: `sha256:${resultDigest}`,
      },
      createdAt: snapshot.completedAt.toISOString(),
    };
    const planHash = createHash("sha256")
      .update(
        canonicalStringify({ ...proposal, tenantId: state.tenantId }),
        "utf8",
      )
      .digest("hex");
    return { ...proposal, id: `ak_${planHash}`, planHash };
  }

  async admit(input: {
    projectId: string;
    runId: string;
    kind: KnowledgeAdmissionKind;
    title?: string;
    text: string;
    approval: string;
    reviewedBy: string;
  }): Promise<KnowledgeAdmissionResult> {
    const plan = await this.plan(input);
    assertKnowledgeIdentifier(input.reviewedBy);
    if (input.approval !== plan.planHash) {
      throw new KnowledgeAdmissionError("KNOWLEDGE_APPROVAL_MISMATCH");
    }
    const state = this.connected();
    const scope = { tenantId: state.tenantId, repositoryId: plan.repositoryId };
    const record: MemoryInput | DecisionInput = {
      ...scope,
      id: plan.id,
      text: plan.text,
      agentId: plan.agentId,
      runId: plan.runId,
      taskId: plan.taskId,
      source: plan.source,
      createdAt: new Date(plan.createdAt),
      ...(plan.kind === "decision" ? { title: plan.title! } : {}),
    };
    const auditBase = {
      actorType: "cli" as const,
      actorId: input.reviewedBy,
      aggregateType: "agent_knowledge",
      aggregateId: plan.id,
      projectId: plan.projectId,
      payload: {
        kind: plan.kind,
        planHash: plan.planHash,
        runId: plan.runId,
        taskId: plan.taskId,
        agentId: plan.agentId,
        repositoryId: plan.repositoryId,
      },
    };
    const fail = async (code: KnowledgeAdmissionErrorCode): Promise<never> => {
      try {
        await this.audit.execute({
          ...auditBase,
          eventType: "knowledge.admission.failed",
          payload: { ...auditBase.payload, errorCode: code },
        });
      } catch {
        // Preserve the bounded admission outcome even when failure auditing is unavailable.
      }
      throw new KnowledgeAdmissionError(code);
    };
    const trace = () =>
      plan.kind === "decision"
        ? state.store.traceDecisionProvenance(scope, plan.id)
        : state.store.traceMemoryProvenance(scope, plan.id);
    const recordOutcome = async (
      outcome: KnowledgeAdmissionResult["outcome"],
    ): Promise<KnowledgeAdmissionResult> => {
      try {
        await this.audit.execute({
          ...auditBase,
          eventType: "knowledge.admission.recorded",
          payload: {
            ...auditBase.payload,
            outcome,
            admittedAt: this.clock.now().toISOString(),
          },
        });
      } catch {
        // The exact record was verified, but its authoritative final audit is uncertain.
        throw new KnowledgeAdmissionError(
          "KNOWLEDGE_ADMISSION_RECONCILIATION_REQUIRED",
        );
      }
      return { ...plan, outcome };
    };
    // Persist approval before any secondary-store mutation. A failed append stops here.
    try {
      await this.audit.execute({
        ...auditBase,
        eventType: "knowledge.admission.approved",
      });
    } catch {
      throw new KnowledgeAdmissionError("KNOWLEDGE_APPROVAL_AUDIT_FAILED");
    }

    let existing: KnowledgeProvenance | null;
    try {
      existing = await trace();
    } catch {
      return fail("KNOWLEDGE_ADMISSION_FAILED");
    }
    if (existing !== null) {
      try {
        this.assertTrace(existing, plan);
      } catch {
        return fail("KNOWLEDGE_ADMISSION_CONFLICT");
      }
      return recordOutcome("reconciled");
    }

    try {
      if (plan.kind === "decision")
        await state.store.recordDecision(record as DecisionInput);
      else await state.store.recordMemory(record);
    } catch {
      // A rejected call can follow a committed remote write. Only an explicit retry reconciles it.
      return fail("KNOWLEDGE_ADMISSION_OUTCOME_UNKNOWN");
    }
    let persisted: KnowledgeProvenance | null;
    try {
      persisted = await trace();
    } catch {
      return fail("KNOWLEDGE_ADMISSION_OUTCOME_UNKNOWN");
    }
    if (persisted === null) return fail("KNOWLEDGE_ADMISSION_OUTCOME_UNKNOWN");
    try {
      this.assertTrace(persisted, plan);
    } catch {
      return fail("KNOWLEDGE_ADMISSION_CONFLICT");
    }
    return recordOutcome("recorded");
  }

  async trace(
    projectId: string,
    kind: KnowledgeAdmissionKind,
    id: string,
  ): Promise<KnowledgeProvenance | null> {
    const state = this.connected();
    assertKnowledgeIdentifier(projectId);
    assertKnowledgeIdentifier(id);
    if (kind !== "memory" && kind !== "decision")
      throw new KnowledgeAdmissionError("KNOWLEDGE_INVALID_KIND");
    if ((await this.projects.findById(projectId)) === null)
      throw new KnowledgeAdmissionError("KNOWLEDGE_PROJECT_NOT_FOUND");
    const repositoryId = await this.identities.findRepositoryId(projectId);
    if (repositoryId === null)
      throw new KnowledgeAdmissionError("KNOWLEDGE_PROVENANCE_UNAVAILABLE");
    const scope = { tenantId: state.tenantId, repositoryId };
    return kind === "decision"
      ? state.store.traceDecisionProvenance(scope, id)
      : state.store.traceMemoryProvenance(scope, id);
  }

  private connected(): Extract<RuntimeAgentKnowledge, { state: "connected" }> {
    if (this.knowledge.state !== "connected")
      throw new KnowledgeAdmissionError("KNOWLEDGE_STORE_NOT_CONNECTED");
    return this.knowledge;
  }

  private assertTrace(
    trace: KnowledgeProvenance | null,
    plan: KnowledgeAdmissionPlan,
  ): void {
    if (
      trace === null ||
      trace.knowledge.id !== plan.id ||
      trace.knowledge.kind !== plan.kind ||
      trace.knowledge.text !== plan.text ||
      trace.knowledge.title !== plan.title ||
      trace.knowledge.runId !== plan.runId ||
      trace.knowledge.taskId !== plan.taskId ||
      trace.knowledge.agentId !== plan.agentId ||
      trace.runId !== plan.runId ||
      trace.taskId !== plan.taskId ||
      trace.agentId !== plan.agentId ||
      trace.knowledge.repositoryId !== plan.repositoryId ||
      trace.knowledge.tenantId !== this.connected().tenantId ||
      trace.source.kind !== "run" ||
      trace.source.label !== plan.source.label ||
      trace.source.locator !== plan.source.locator ||
      trace.source.id !== plan.runId ||
      trace.knowledge.source.kind !== plan.source.kind ||
      trace.knowledge.source.id !== plan.source.id ||
      trace.knowledge.source.label !== plan.source.label ||
      trace.knowledge.source.locator !== plan.source.locator ||
      trace.knowledge.createdAt.toISOString() !== plan.createdAt
    ) {
      throw new KnowledgeAdmissionError("KNOWLEDGE_INVALID_PROVENANCE");
    }
  }
}
