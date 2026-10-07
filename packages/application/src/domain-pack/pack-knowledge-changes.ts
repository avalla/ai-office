import { createHash } from "node:crypto";
import { canonicalizeJcsJson } from "../../../domain-pack-contracts/src/jcs.ts";
import {
  hasKnowledgeGuidance,
  knowledgeGuidance,
  type KnowledgeGuidance,
} from "./pack-knowledge-guidance.ts";
import type { ResolvedPackManifest } from "./resolve-installed-pack-manifests.ts";
import { stablePackDefinitionId } from "./resolve-project-configuration.ts";

/**
 * The typed guidance a resolved closure declares for one knowledge entry
 * (GP-15): a stable identity and the guidance values, never a title or a
 * description.
 */
export type PackKnowledgeGuidance = KnowledgeGuidance & {
  readonly knowledgeId: string;
};

/**
 * A knowledge entry whose typed guidance differs between two resolved
 * closures. `before` is absent when the first closure declares none for it,
 * `after` when the second declares none.
 */
export interface KnowledgeGuidanceDifference {
  readonly knowledgeId: string;
  readonly change: "added" | "removed" | "changed";
  readonly before?: PackKnowledgeGuidance;
  readonly after?: PackKnowledgeGuidance;
}

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Stable IDs of every knowledge entry a closure provides, typed or not. */
export function closureKnowledgeIds(
  closure: readonly ResolvedPackManifest[],
): Set<string> {
  return new Set(
    closure.flatMap(({ identity, manifest }) =>
      manifest.contributions.knowledge.map((entry) =>
        stablePackDefinitionId(identity.id, "knowledge", entry.id),
      ),
    ),
  );
}

/**
 * Every knowledge entry of one closure that declares typed guidance, by
 * stable ID. A descriptive entry has no guidance to report.
 */
export function closureKnowledgeGuidance(
  closure: readonly ResolvedPackManifest[],
): PackKnowledgeGuidance[] {
  return closure
    .flatMap(({ identity, manifest }) =>
      manifest.contributions.knowledge.flatMap((entry) => {
        const guidance = knowledgeGuidance(entry);
        return hasKnowledgeGuidance(guidance)
          ? [
              {
                knowledgeId: stablePackDefinitionId(
                  identity.id,
                  "knowledge",
                  entry.id,
                ),
                ...guidance,
              },
            ]
          : [];
      }),
    )
    .sort((left, right) => compare(left.knowledgeId, right.knowledgeId));
}

/**
 * Every knowledge entry whose typed guidance differs between `before` and
 * `after`. Presentation is not compared. The one computation behind the
 * upgrade plan and the pack binding guard.
 */
export function knowledgeGuidanceDifferences(
  before: readonly ResolvedPackManifest[],
  after: readonly ResolvedPackManifest[],
): KnowledgeGuidanceDifference[] {
  const byEntry = (closure: readonly ResolvedPackManifest[]) =>
    new Map(
      closureKnowledgeGuidance(closure).map((entry) => [
        entry.knowledgeId,
        entry,
      ]),
    );
  const old = byEntry(before);
  const next = byEntry(after);
  const differences: KnowledgeGuidanceDifference[] = [];
  for (const knowledgeId of new Set([...old.keys(), ...next.keys()])) {
    const previous = old.get(knowledgeId);
    const current = next.get(knowledgeId);
    if (previous === undefined && current !== undefined)
      differences.push({ knowledgeId, change: "added", after: current });
    else if (previous !== undefined && current === undefined)
      differences.push({ knowledgeId, change: "removed", before: previous });
    else if (
      previous !== undefined &&
      current !== undefined &&
      canonicalizeJcsJson(previous) !== canonicalizeJcsJson(current)
    )
      differences.push({
        knowledgeId,
        change: "changed",
        before: previous,
        after: current,
      });
  }
  return differences.sort((left, right) =>
    compare(left.knowledgeId, right.knowledgeId),
  );
}

/** The digest of one guidance: its canonical JSON, without the identity. */
export function knowledgeGuidanceDigest(
  guidance: PackKnowledgeGuidance,
): string {
  const { knowledgeId: _knowledgeId, ...values } = guidance;
  return `sha256:${createHash("sha256")
    .update("ai-office-pack-knowledge-guidance-v1\n", "utf8")
    .update(canonicalizeJcsJson(values as never), "utf8")
    .digest("hex")}`;
}

/**
 * What the audit event records of a plan's knowledge fields: identities and
 * one digest per guidance, never a schema description, a hint or a seed. The
 * approver reads the full guidance in the plan the digest binds.
 */
export function knowledgeAuditRecord(plan: {
  readonly knowledgeChanges:
    | {
        readonly availability: "available";
        readonly changes: readonly (KnowledgeGuidanceDifference & {
          readonly customized: boolean;
        })[];
      }
    | {
        readonly availability: "unavailable";
        readonly reason: string;
        readonly detail: string;
      };
  readonly targetKnowledge: readonly PackKnowledgeGuidance[];
}) {
  return {
    knowledgeChanges:
      plan.knowledgeChanges.availability === "unavailable"
        ? plan.knowledgeChanges
        : {
            availability: "available" as const,
            changes: plan.knowledgeChanges.changes.map((item) => ({
              knowledgeId: item.knowledgeId,
              change: item.change,
              customized: item.customized,
              ...(item.before === undefined
                ? {}
                : { beforeDigest: knowledgeGuidanceDigest(item.before) }),
              ...(item.after === undefined
                ? {}
                : { afterDigest: knowledgeGuidanceDigest(item.after) }),
            })),
          },
    targetKnowledge: plan.targetKnowledge.map((item) => ({
      knowledgeId: item.knowledgeId,
      guidanceDigest: knowledgeGuidanceDigest(item),
    })),
  };
}
