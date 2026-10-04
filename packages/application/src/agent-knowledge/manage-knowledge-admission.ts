import { createHash } from "node:crypto";
import {
  canonicalStringify,
  normalizeCanonicalJson,
} from "@ai-office/domain/capability/canonical-json.ts";
import {
  assertKnowledgeIdentifier,
  assertKnowledgeSearchQuery,
  isKnowledgeIdentifier,
  knowledgeEvidenceKinds,
  knowledgeEvidenceLimit,
  type DecisionInput,
  type KnowledgeEvidenceKind,
  type KnowledgeEvidenceReference,
  type KnowledgeProvenance,
  type LegacyKnowledgeHit,
  type MemoryInput,
  type NonRunKnowledgeProvenance,
  type RuntimeAgentKnowledge,
  type SearchKnowledgeHit,
} from "../ports/agent-knowledge-store.port.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { GovernanceRepository } from "../ports/governance-repository.port.ts";
import type { ProjectProfileRepository } from "../ports/project-profile-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { RepositoryIdentityRepository } from "../ports/repository-identity-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type { RecordAuditEvent } from "../commands/record-audit-event.ts";
import {
  readRecordedRepositoryReview,
  repositoryFactsFromProfile,
  repositoryUnderstandingFingerprint,
} from "../project-lifecycle/repository-understanding.ts";

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
  | "KNOWLEDGE_HANDOVER_NOT_CONFIRMED"
  | "KNOWLEDGE_HANDOVER_STALE"
  | "KNOWLEDGE_EVIDENCE_UNAVAILABLE"
  | "KNOWLEDGE_CONFIRMATION_MISMATCH"
  | "KNOWLEDGE_PROJECT_NOT_FOUND"
  | "KNOWLEDGE_STORE_NOT_CONNECTED";

export class KnowledgeAdmissionError extends Error {
  constructor(readonly code: KnowledgeAdmissionErrorCode) {
    super(code);
    this.name = "KnowledgeAdmissionError";
  }
}

/**
 * The closed set of admission sources. Each names evidence the Runtime can
 * verify inside the project; a host-client session is not one of them.
 */
export type KnowledgeAdmissionSourceInput =
  | { readonly kind: "agent_run"; readonly runId: string }
  | { readonly kind: "handover"; readonly confirmationId: string }
  | {
      readonly kind: "operator_confirmed";
      readonly confirmedBy: string;
      readonly evidence: readonly {
        readonly kind: string;
        readonly id: string;
      }[];
    };

export interface KnowledgeAdmissionInput {
  projectId: string;
  /** Shorthand for `{ kind: "agent_run", runId }`; exclusive with `source`. */
  runId?: string;
  source?: KnowledgeAdmissionSourceInput;
  kind: KnowledgeAdmissionKind;
  title?: string;
  text: string;
}

interface KnowledgeAdmissionPlanContent {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly kind: KnowledgeAdmissionKind;
  readonly id: string;
  readonly title: string | null;
  readonly text: string;
  readonly planHash: string;
}

/** Unchanged from AK-05, so existing run-backed records keep their identity. */
export interface RunKnowledgeAdmissionPlan extends KnowledgeAdmissionPlanContent {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly source: {
    readonly kind: "run";
    readonly id: string;
    readonly label: string;
    readonly locator: string;
  };
  readonly createdAt: string;
  readonly provenance: {
    readonly kind: "agent_run";
    readonly runId: string;
    readonly taskId: string;
    readonly agentId: string;
  };
}

export type NonRunKnowledgePlanProvenance =
  | {
      readonly kind: "handover";
      readonly confirmationId: string;
      readonly fingerprint: string;
      readonly scanId: string | null;
      readonly confirmedAt: string;
    }
  | {
      readonly kind: "operator_confirmed";
      readonly confirmedBy: string;
      readonly evidence: readonly KnowledgeEvidenceReference[];
    };

export interface NonRunKnowledgeAdmissionPlan extends KnowledgeAdmissionPlanContent {
  readonly schemaVersion: 2;
  readonly runId: null;
  readonly taskId: null;
  readonly agentId: null;
  readonly source: {
    readonly kind: "handover" | "operator";
    readonly id: string;
    readonly label: string;
    readonly locator: string;
  };
  /** Null for an operator confirmation: the record is dated at admission. */
  readonly createdAt: string | null;
  readonly provenance: NonRunKnowledgePlanProvenance;
}

export type KnowledgeAdmissionPlan =
  RunKnowledgeAdmissionPlan | NonRunKnowledgeAdmissionPlan;

export type KnowledgeAdmissionResult = KnowledgeAdmissionPlan & {
  readonly outcome: "recorded" | "reconciled";
};

export const knowledgeAdmissionAuditEvents = [
  "knowledge.admission.approved",
  "knowledge.admission.recorded",
  "knowledge.admission.failed",
] as const;

/** Why a record exists: the verified source and the admission that wrote it. */
export interface KnowledgeTraceExplanation {
  readonly provenance: KnowledgeProvenance | LegacyKnowledgeHit;
  readonly admissionSource:
    | {
        readonly kind: "agent_run";
        readonly projectId: string;
        readonly runId: string;
        readonly taskId: string;
        readonly agentId: string;
      }
    | ({ readonly projectId: string } & NonRunKnowledgePlanProvenance)
    | {
        readonly kind: "legacy_import";
        readonly projectId: string;
        readonly sourceScope: string;
        readonly sourceKey: string;
        readonly sourceSha256: string;
      };
  /** Null for an imported legacy record, which no governed admission wrote. */
  readonly admission: {
    readonly planHash: string | null;
    readonly audit: {
      readonly aggregateType: "agent_knowledge";
      readonly aggregateId: string;
      readonly eventTypes: typeof knowledgeAdmissionAuditEvents;
    };
  } | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && keys.every((key) => actual.includes(key))
  );
}

function planProvenance(
  provenance: NonRunKnowledgeProvenance,
): NonRunKnowledgePlanProvenance {
  return provenance.kind === "handover"
    ? { ...provenance, confirmedAt: provenance.confirmedAt.toISOString() }
    : {
        kind: provenance.kind,
        confirmedBy: provenance.confirmedBy,
        evidence: provenance.evidence.map(({ kind, id, label }) => ({
          kind,
          id,
          label,
        })),
      };
}

/**
 * New knowledge is admitted only from a verified source (a completed worker
 * run, a confirmed handover review, or operator-confirmed project evidence)
 * and an exact operator-reviewed plan. No source is inferred, and none is
 * fabricated to satisfy another's shape.
 */
export class ManageKnowledgeAdmission {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly tasks: TaskRepository,
    private readonly runtime: AgentRuntimeRepository,
    private readonly identities: RepositoryIdentityRepository,
    private readonly knowledge: RuntimeAgentKnowledge,
    private readonly audit: RecordAuditEvent,
    private readonly clock: Clock,
    private readonly profiles: ProjectProfileRepository,
    private readonly governance: GovernanceRepository,
  ) {}

  async plan(input: KnowledgeAdmissionInput): Promise<KnowledgeAdmissionPlan> {
    const state = this.connected();
    assertKnowledgeIdentifier(input.projectId);
    const source = this.source(input);
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
    const [project, repositoryId] = await Promise.all([
      this.projects.findById(input.projectId),
      this.identities.findRepositoryId(input.projectId),
    ]);
    if (project === null || repositoryId === null) {
      throw new KnowledgeAdmissionError("KNOWLEDGE_PROVENANCE_UNAVAILABLE");
    }
    assertKnowledgeIdentifier(repositoryId);
    const content = {
      projectId: input.projectId,
      repositoryId,
      kind: input.kind,
      title: input.kind === "decision" ? input.title! : null,
      text: input.text,
    };
    if (source.kind === "agent_run")
      return this.planFromRun(content, source.runId, state.tenantId);

    const provenance =
      source.kind === "handover"
        ? await this.confirmedHandover(input.projectId, source.confirmationId)
        : {
            kind: "operator_confirmed" as const,
            confirmedBy: source.confirmedBy,
            evidence: await this.evidence(input.projectId, source.evidence),
          };
    const proposal = {
      schemaVersion: 2 as const,
      ...content,
      runId: null,
      taskId: null,
      agentId: null,
      source:
        provenance.kind === "handover"
          ? {
              kind: "handover" as const,
              id: provenance.confirmationId,
              label: `Confirmed handover review ${provenance.confirmationId}`,
              locator: `sha256:${provenance.fingerprint}`,
            }
          : {
              kind: "operator" as const,
              id: provenance.confirmedBy,
              label: `Operator confirmation by ${provenance.confirmedBy}`,
              locator: `sha256:${sha256(canonicalStringify(provenance.evidence))}`,
            },
      createdAt:
        provenance.kind === "handover"
          ? provenance.confirmedAt.toISOString()
          : null,
      provenance: planProvenance(provenance),
    };
    const planHash = sha256(
      canonicalStringify({ ...proposal, tenantId: state.tenantId }),
    );
    return { ...proposal, id: `ak_${planHash}`, planHash };
  }

  /** Exactly one explicit source; fields of another source kind are rejected. */
  private source(
    input: KnowledgeAdmissionInput,
  ): KnowledgeAdmissionSourceInput {
    const invalid = () =>
      new KnowledgeAdmissionError("KNOWLEDGE_INVALID_PROVENANCE");
    if (input.source === undefined) {
      if (input.runId === undefined) throw invalid();
      assertKnowledgeIdentifier(input.runId);
      return { kind: "agent_run", runId: input.runId };
    }
    const source: unknown = input.source;
    if (
      input.runId !== undefined ||
      typeof source !== "object" ||
      source === null ||
      Array.isArray(source)
    )
      throw invalid();
    const candidate = source as Record<string, unknown>;
    if (candidate.kind === "agent_run") {
      if (!hasExactKeys(candidate, ["kind", "runId"])) throw invalid();
      // A malformed run ID keeps its AK-05 error.
      assertKnowledgeIdentifier(candidate.runId);
      return { kind: "agent_run", runId: candidate.runId };
    }
    if (candidate.kind === "handover") {
      if (
        !hasExactKeys(candidate, ["kind", "confirmationId"]) ||
        !isKnowledgeIdentifier(candidate.confirmationId)
      )
        throw invalid();
      return { kind: "handover", confirmationId: candidate.confirmationId };
    }
    if (candidate.kind === "operator_confirmed") {
      const evidence = candidate.evidence;
      if (
        !hasExactKeys(candidate, ["kind", "confirmedBy", "evidence"]) ||
        !isKnowledgeIdentifier(candidate.confirmedBy) ||
        /[\p{Cc}\p{Cf}]/u.test(candidate.confirmedBy) ||
        !Array.isArray(evidence) ||
        evidence.length < 1 ||
        evidence.length > knowledgeEvidenceLimit
      )
        throw invalid();
      const references = evidence.map((item: unknown) => {
        if (typeof item !== "object" || item === null || Array.isArray(item))
          throw invalid();
        const reference = item as Record<string, unknown>;
        if (
          !hasExactKeys(reference, ["kind", "id"]) ||
          !knowledgeEvidenceKinds.includes(
            reference.kind as KnowledgeEvidenceKind,
          ) ||
          !isKnowledgeIdentifier(reference.id)
        )
          throw invalid();
        return { kind: reference.kind as string, id: reference.id };
      });
      if (
        new Set(references.map((item) => `${item.kind}:${item.id}`)).size !==
        references.length
      )
        throw invalid();
      return {
        kind: "operator_confirmed",
        confirmedBy: candidate.confirmedBy,
        evidence: references,
      };
    }
    throw invalid();
  }

  private async planFromRun(
    content: {
      projectId: string;
      repositoryId: string;
      kind: KnowledgeAdmissionKind;
      title: string | null;
      text: string;
    },
    runId: string,
    tenantId: string,
  ): Promise<RunKnowledgeAdmissionPlan> {
    const run = await this.runtime.findRun(runId);
    if (run === null) {
      throw new KnowledgeAdmissionError("KNOWLEDGE_PROVENANCE_UNAVAILABLE");
    }
    const snapshot = run.snapshot();
    if (
      snapshot.projectId !== content.projectId ||
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
      task?.snapshot().projectId !== content.projectId ||
      agent?.projectId !== content.projectId
    ) {
      throw new KnowledgeAdmissionError("KNOWLEDGE_PROVENANCE_UNAVAILABLE");
    }
    let resultDigest: string;
    try {
      resultDigest = sha256(
        canonicalStringify(normalizeCanonicalJson(snapshot.result)),
      );
    } catch {
      throw new KnowledgeAdmissionError("KNOWLEDGE_PROVENANCE_UNAVAILABLE");
    }
    // This hashed shape is the AK-05 contract. The run, task, and agent in it
    // are the exact provenance, so `provenance` below only restates them.
    const proposal = {
      schemaVersion: 1 as const,
      projectId: content.projectId,
      repositoryId: content.repositoryId,
      runId: snapshot.id,
      taskId: snapshot.taskId,
      agentId: snapshot.agentId,
      kind: content.kind,
      title: content.title,
      text: content.text,
      source: {
        kind: "run" as const,
        id: snapshot.id,
        label: `Agent run ${snapshot.id}`,
        locator: `sha256:${resultDigest}`,
      },
      createdAt: snapshot.completedAt.toISOString(),
    };
    const planHash = sha256(canonicalStringify({ ...proposal, tenantId }));
    return {
      ...proposal,
      id: `ak_${planHash}`,
      planHash,
      provenance: {
        kind: "agent_run",
        runId: snapshot.id,
        taskId: snapshot.taskId,
        agentId: snapshot.agentId,
      },
    };
  }

  /**
   * Resolves the project's active, user-confirmed repository review. A scan,
   * an import, an agent interpretation, or an approved office manifest is not
   * one; neither is a superseded confirmation, another project's, or one whose
   * repository evidence has since changed.
   */
  private async confirmedHandover(
    projectId: string,
    confirmationId: string,
    unavailable: KnowledgeAdmissionErrorCode = "KNOWLEDGE_HANDOVER_NOT_CONFIRMED",
    stale: KnowledgeAdmissionErrorCode = "KNOWLEDGE_HANDOVER_STALE",
  ): Promise<Extract<NonRunKnowledgeProvenance, { kind: "handover" }>> {
    const entries = await this.profiles.listActiveProfileEntries(projectId);
    const facts = repositoryFactsFromProfile(entries);
    const recorded = readRecordedRepositoryReview(entries);
    if (
      facts === null ||
      recorded === null ||
      recorded.entry.id !== confirmationId ||
      recorded.entry.projectId !== projectId ||
      recorded.entry.confirmedAt === undefined ||
      !/^[0-9a-f]{64}$/u.test(recorded.review.fingerprint) ||
      (recorded.review.scanId !== null &&
        !isKnowledgeIdentifier(recorded.review.scanId))
    )
      throw new KnowledgeAdmissionError(unavailable);
    if (
      recorded.review.fingerprint !== repositoryUnderstandingFingerprint(facts)
    )
      throw new KnowledgeAdmissionError(stale);
    return {
      kind: "handover",
      confirmationId,
      fingerprint: recorded.review.fingerprint,
      scanId: recorded.review.scanId,
      confirmedAt: recorded.entry.confirmedAt,
    };
  }

  /** Every reference must resolve to a record of this project; order never matters. */
  private async evidence(
    projectId: string,
    references: readonly { readonly kind: string; readonly id: string }[],
  ): Promise<KnowledgeEvidenceReference[]> {
    const unavailable = () =>
      new KnowledgeAdmissionError("KNOWLEDGE_EVIDENCE_UNAVAILABLE");
    const governance = references.some(
      ({ kind }) =>
        kind === "requirement" || kind === "adr" || kind === "review",
    )
      ? await this.governance.getSnapshot(projectId)
      : null;
    const resolved = await Promise.all(
      references.map(
        async ({ kind, id }): Promise<KnowledgeEvidenceReference> => {
          if (kind === "requirement") {
            const requirement = governance?.requirements.find(
              (item) =>
                item.id === id &&
                item.projectId === projectId &&
                item.status !== "rejected",
            );
            if (
              requirement === undefined ||
              !isKnowledgeIdentifier(requirement.key)
            )
              throw unavailable();
            return { kind, id, label: `Requirement ${requirement.key}` };
          }
          if (kind === "adr") {
            if (
              !governance?.adrs.some(
                (item) =>
                  item.id === id &&
                  item.projectId === projectId &&
                  item.status === "accepted",
              )
            )
              throw unavailable();
            return { kind, id, label: `ADR ${id}` };
          }
          if (kind === "review") {
            // Only a conclusion that stands supports knowledge: an accepted
            // ADR, an approved review, a requirement that was not rejected.
            if (
              !governance?.reviews.some(
                (item) =>
                  item.id === id &&
                  item.projectId === projectId &&
                  item.status === "approved",
              )
            )
              throw unavailable();
            return { kind, id, label: `Review ${id}` };
          }
          if (kind === "task") {
            const task = await this.tasks.findById(id);
            if (task?.snapshot().projectId !== projectId) throw unavailable();
            return { kind, id, label: `Task ${id}` };
          }
          if (kind === "handover") {
            await this.confirmedHandover(
              projectId,
              id,
              "KNOWLEDGE_EVIDENCE_UNAVAILABLE",
              "KNOWLEDGE_EVIDENCE_UNAVAILABLE",
            );
            return { kind, id, label: `Handover review ${id}` };
          }
          throw new KnowledgeAdmissionError("KNOWLEDGE_INVALID_PROVENANCE");
        },
      ),
    );
    // A label the store could not hold must fail here, before any approval.
    if (resolved.some(({ label }) => !isKnowledgeIdentifier(label)))
      throw unavailable();
    return resolved.sort(
      (left, right) =>
        (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
  }

  async admit(
    input: KnowledgeAdmissionInput & { approval: string; reviewedBy: string },
  ): Promise<KnowledgeAdmissionResult> {
    const plan = await this.plan(input);
    assertKnowledgeIdentifier(input.reviewedBy);
    if (input.approval !== plan.planHash) {
      throw new KnowledgeAdmissionError("KNOWLEDGE_APPROVAL_MISMATCH");
    }
    // The operator named in the reviewed plan is the only one who can confirm it.
    if (
      plan.provenance.kind === "operator_confirmed" &&
      plan.provenance.confirmedBy !== input.reviewedBy
    ) {
      throw new KnowledgeAdmissionError("KNOWLEDGE_CONFIRMATION_MISMATCH");
    }
    const state = this.connected();
    const scope = { tenantId: state.tenantId, repositoryId: plan.repositoryId };
    // An operator confirmation has no earlier authoritative timestamp to inherit.
    const admittedAt = this.clock.now();
    const auditBase = {
      actorType: "cli" as const,
      actorId: input.reviewedBy,
      aggregateType: "agent_knowledge",
      aggregateId: plan.id,
      projectId: plan.projectId,
      payload:
        plan.schemaVersion === 1
          ? {
              kind: plan.kind,
              planHash: plan.planHash,
              provenanceKind: plan.provenance.kind,
              runId: plan.runId,
              taskId: plan.taskId,
              agentId: plan.agentId,
              repositoryId: plan.repositoryId,
            }
          : {
              kind: plan.kind,
              planHash: plan.planHash,
              provenanceKind: plan.provenance.kind,
              repositoryId: plan.repositoryId,
              provenance:
                plan.provenance.kind === "handover"
                  ? plan.provenance
                  : {
                      kind: plan.provenance.kind,
                      confirmedBy: plan.provenance.confirmedBy,
                      evidence: plan.provenance.evidence.map(
                        ({ kind, id }) => ({ kind, id }),
                      ),
                    },
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
            admittedAt: admittedAt.toISOString(),
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
      if (plan.schemaVersion === 2) {
        await state.store.recordNonRunKnowledge({
          ...scope,
          id: plan.id,
          kind: plan.kind,
          text: plan.text,
          ...(plan.title === null ? {} : { title: plan.title }),
          source: plan.source,
          createdAt:
            plan.createdAt === null ? admittedAt : new Date(plan.createdAt),
          provenance:
            plan.provenance.kind === "handover"
              ? {
                  ...plan.provenance,
                  confirmedAt: new Date(plan.provenance.confirmedAt),
                }
              : plan.provenance,
        });
      } else {
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
        if (plan.kind === "decision")
          await state.store.recordDecision(record as DecisionInput);
        else await state.store.recordMemory(record);
      }
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
  ): Promise<KnowledgeProvenance | LegacyKnowledgeHit | null> {
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
    if (kind === "decision")
      return state.store.traceDecisionProvenance(scope, id);
    return (
      (await state.store.traceMemoryProvenance(scope, id)) ??
      state.store.traceLegacyMemory(scope, id)
    );
  }

  /**
   * Explains why a record exists: its verified source, the project it belongs
   * to, and where the approval and outcome of its admission are audited.
   */
  async explain(
    projectId: string,
    kind: KnowledgeAdmissionKind,
    id: string,
  ): Promise<KnowledgeTraceExplanation | null> {
    const provenance = await this.trace(projectId, kind, id);
    if (provenance === null) return null;
    if ("legacy" in provenance)
      return {
        provenance,
        admissionSource: {
          kind: "legacy_import",
          projectId,
          ...provenance.legacy,
        },
        admission: null,
      };
    const hit = provenance.knowledge;
    return {
      provenance,
      admissionSource:
        hit.runId === null
          ? { projectId, ...planProvenance(hit.provenance) }
          : {
              kind: "agent_run",
              projectId,
              runId: hit.runId,
              taskId: hit.taskId,
              agentId: hit.agentId,
            },
      admission: {
        planHash: /^ak_[0-9a-f]{64}$/u.test(id) ? id.slice(3) : null,
        audit: {
          aggregateType: "agent_knowledge",
          aggregateId: id,
          eventTypes: knowledgeAdmissionAuditEvents,
        },
      },
    };
  }

  /**
   * Read-only duplicate check before a new plan: one literal substring in the
   * project's trusted scope, with the store's fixed bounds. It writes nothing.
   */
  async search(input: {
    projectId: string;
    text: string;
    limit?: number;
    agentId?: string;
  }): Promise<SearchKnowledgeHit[]> {
    const state = this.connected();
    assertKnowledgeIdentifier(input.projectId);
    const query = {
      text: input.text,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    };
    assertKnowledgeSearchQuery(query);
    if ((await this.projects.findById(input.projectId)) === null)
      throw new KnowledgeAdmissionError("KNOWLEDGE_PROJECT_NOT_FOUND");
    const repositoryId = await this.identities.findRepositoryId(
      input.projectId,
    );
    if (repositoryId === null)
      throw new KnowledgeAdmissionError("KNOWLEDGE_PROVENANCE_UNAVAILABLE");
    return state.store.findKnowledge(
      { tenantId: state.tenantId, repositoryId },
      query,
    );
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
    const invalid = new KnowledgeAdmissionError("KNOWLEDGE_INVALID_PROVENANCE");
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
      trace.source.kind !== plan.source.kind ||
      trace.source.label !== plan.source.label ||
      trace.source.locator !== plan.source.locator ||
      trace.source.id !== plan.source.id ||
      trace.knowledge.source.kind !== plan.source.kind ||
      trace.knowledge.source.id !== plan.source.id ||
      trace.knowledge.source.label !== plan.source.label ||
      trace.knowledge.source.locator !== plan.source.locator ||
      (plan.createdAt !== null &&
        trace.knowledge.createdAt.toISOString() !== plan.createdAt)
    ) {
      throw invalid;
    }
    if (plan.schemaVersion === 1) {
      if (trace.knowledge.runId === null) throw invalid;
      return;
    }
    if (
      trace.knowledge.runId !== null ||
      canonicalStringify(planProvenance(trace.knowledge.provenance)) !==
        canonicalStringify(plan.provenance)
    ) {
      throw invalid;
    }
  }
}
