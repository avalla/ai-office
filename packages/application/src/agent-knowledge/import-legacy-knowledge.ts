import { createHash } from "node:crypto";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import { deriveProjectMemoryIdentity } from "../project-memory/project-memory-identity.ts";
import {
  assertKnowledgeIdentifier,
  type LegacyKnowledgeHit,
  type RuntimeAgentKnowledge,
} from "../ports/agent-knowledge-store.port.ts";
import {
  parseCompleteLegacyMemorySource,
  legacyMemoryLimits,
  type LegacyMemoryReader,
} from "../ports/legacy-memory-reader.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { RepositoryIdentityRepository } from "../ports/repository-identity-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { RecordAuditEvent } from "../commands/record-audit-event.ts";
import {
  KnowledgeAdmissionError,
  type KnowledgeAdmissionErrorCode,
} from "./manage-knowledge-admission.ts";

const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const legacySourceLabel = "CairnKeep named scope";

function isExactLegacyHit(
  value: unknown,
  scope: { tenantId: string; repositoryId: string },
  sourceScope: string,
  entry: LegacyImportPlan["entries"][number],
): value is LegacyKnowledgeHit {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const hit = value as LegacyKnowledgeHit;
    return hit.tenantId === scope.tenantId &&
      hit.repositoryId === scope.repositoryId && hit.id === entry.id &&
      hit.kind === "memory" && hit.text === entry.text && hit.title === null &&
      hit.agentId === null && hit.runId === null && hit.taskId === null &&
      hit.legacy?.sourceScope === sourceScope &&
      hit.legacy.sourceKey === entry.key &&
      hit.legacy.sourceSha256 === entry.sourceSha256 &&
      hit.source?.kind === "external" && hit.source.id === entry.key &&
      hit.source.label === legacySourceLabel &&
      hit.source.locator === entry.sourceSha256 &&
      hit.createdAt instanceof Date && Number.isFinite(hit.createdAt.getTime());
  } catch {
    return false;
  }
}

export interface LegacyImportPlan {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly sourceScope: string;
  readonly entries: readonly {
    readonly id: string;
    readonly key: string;
    readonly text: string;
    readonly sourceSha256: string;
  }[];
  readonly planHash: string;
}

/** Operator-reviewed migration of one complete, bounded named scope. No run provenance is inferred. */
export class ImportLegacyKnowledge {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly identities: RepositoryIdentityRepository,
    private readonly reader: LegacyMemoryReader | undefined,
    private readonly knowledge: RuntimeAgentKnowledge,
    private readonly audit: RecordAuditEvent,
    private readonly clock: Clock,
  ) {}

  async plan(
    projectId: string,
    sourceScope: string,
  ): Promise<LegacyImportPlan> {
    assertKnowledgeIdentifier(projectId);
    const state = this.knowledge;
    if (state.state !== "connected")
      throw new KnowledgeAdmissionError("KNOWLEDGE_STORE_NOT_CONNECTED");
    if (this.reader === undefined)
      throw new KnowledgeAdmissionError("KNOWLEDGE_LEGACY_SOURCE_UNAVAILABLE");
    const [project, repositoryId] = await Promise.all([
      this.projects.findById(projectId),
      this.identities.findRepositoryId(projectId),
    ]);
    if (project === null || repositoryId === null)
      throw new KnowledgeAdmissionError("KNOWLEDGE_PROVENANCE_UNAVAILABLE");
    assertKnowledgeIdentifier(repositoryId);
    if (
      sourceScope !== deriveProjectMemoryIdentity(repositoryId).memoryProjectId
    )
      throw new KnowledgeAdmissionError("KNOWLEDGE_LEGACY_SCOPE_MISMATCH");
    let source: Awaited<ReturnType<LegacyMemoryReader["readNamedScope"]>>;
    try {
      source = await this.reader.readNamedScope(sourceScope);
    } catch {
      throw new KnowledgeAdmissionError("KNOWLEDGE_LEGACY_SOURCE_UNAVAILABLE");
    }
    const complete = parseCompleteLegacyMemorySource(source);
    if (complete === null)
      throw new KnowledgeAdmissionError("KNOWLEDGE_LEGACY_SOURCE_UNAVAILABLE");
    const entries = complete
      .map((entry) => {
        const id = `ak_legacy_${digest(
          canonicalStringify([
            state.tenantId,
            repositoryId,
            sourceScope,
            entry.key,
          ]),
        )}`;
        return {
          id,
          key: entry.key,
          text: entry.value,
          sourceSha256: `sha256:${digest(entry.value)}`,
        };
      })
      .sort((left, right) =>
        left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
      );
    // Separate bound on the review surface, after the complete source byte check.
    if (Buffer.byteLength(JSON.stringify(entries), "utf8") > legacyMemoryLimits.serializedPlanBytes)
      throw new KnowledgeAdmissionError("KNOWLEDGE_LEGACY_SOURCE_UNAVAILABLE");
    const proposal = {
      schemaVersion: 1 as const,
      projectId,
      repositoryId,
      sourceScope,
      entries,
    };
    return {
      ...proposal,
      planHash: digest(
        canonicalStringify({
          ...proposal,
          tenantId: state.tenantId,
        }),
      ),
    };
  }

  async import(input: {
    projectId: string;
    sourceScope: string;
    approval: string;
    reviewedBy: string;
  }): Promise<{ planHash: string; imported: number; reconciled: number }> {
    const plan = await this.plan(input.projectId, input.sourceScope);
    assertKnowledgeIdentifier(input.reviewedBy);
    if (plan.planHash !== input.approval)
      throw new KnowledgeAdmissionError("KNOWLEDGE_APPROVAL_MISMATCH");
    if (this.knowledge.state !== "connected")
      throw new KnowledgeAdmissionError("KNOWLEDGE_STORE_NOT_CONNECTED");
    const scope = {
      tenantId: this.knowledge.tenantId,
      repositoryId: plan.repositoryId,
    };
    const base = {
      actorType: "cli" as const,
      actorId: input.reviewedBy,
      aggregateType: "agent_knowledge",
      aggregateId: plan.planHash,
      projectId: plan.projectId,
      payload: {
        planHash: plan.planHash,
        repositoryId: plan.repositoryId,
        sourceScope: plan.sourceScope,
        count: plan.entries.length,
      },
    };
    try {
      await this.audit.execute({
        ...base,
        eventType: "knowledge.legacy_import.approved",
      });
    } catch {
      throw new KnowledgeAdmissionError("KNOWLEDGE_APPROVAL_AUDIT_FAILED");
    }
    let imported = 0;
    let reconciled = 0;
    const fail = async (code: KnowledgeAdmissionErrorCode): Promise<never> => {
      try {
        await this.audit.execute({
          ...base,
          eventType: "knowledge.legacy_import.failed",
          payload: { ...base.payload, imported, reconciled, errorCode: code },
        });
      } catch {
        // Preserve the bounded outcome when failure auditing is unavailable.
      }
      throw new KnowledgeAdmissionError(code);
    };
    for (const entry of plan.entries) {
      let found: LegacyKnowledgeHit | null;
      try {
        found = await this.knowledge.store.traceLegacyMemory(scope, entry.id);
      } catch {
        return fail("KNOWLEDGE_LEGACY_IMPORT_OUTCOME_UNKNOWN");
      }
      if (found !== null) {
        if (!isExactLegacyHit(found, scope, plan.sourceScope, entry))
          return fail("KNOWLEDGE_LEGACY_IMPORT_CONFLICT");
        reconciled++;
        continue;
      }
      let writeOutcome: "recorded" | "existing";
      try {
        writeOutcome = await this.knowledge.store.recordLegacyMemory({
          ...scope,
          id: entry.id,
          text: entry.text,
          sourceScope: plan.sourceScope,
          sourceKey: entry.key,
          sourceSha256: entry.sourceSha256,
          importedAt: this.clock.now(),
        });
        found = await this.knowledge.store.traceLegacyMemory(scope, entry.id);
      } catch {
        return fail("KNOWLEDGE_LEGACY_IMPORT_OUTCOME_UNKNOWN");
      }
      if (!isExactLegacyHit(found, scope, plan.sourceScope, entry))
        return fail("KNOWLEDGE_LEGACY_IMPORT_OUTCOME_UNKNOWN");
      if (writeOutcome === "recorded") imported++;
      else if (writeOutcome === "existing") reconciled++;
      else return fail("KNOWLEDGE_LEGACY_IMPORT_OUTCOME_UNKNOWN");
    }
    try {
      await this.audit.execute({
        ...base,
        eventType: "knowledge.legacy_import.recorded",
        payload: { ...base.payload, imported, reconciled },
      });
    } catch {
      throw new KnowledgeAdmissionError(
        "KNOWLEDGE_ADMISSION_RECONCILIATION_REQUIRED",
      );
    }
    return { planHash: plan.planHash, imported, reconciled };
  }
}
