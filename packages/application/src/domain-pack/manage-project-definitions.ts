import { AuditEvent } from "@ai-office/domain/event/audit-event.ts";
import { verifyDomainPackManifest } from "../../../domain-pack-contracts/src/index.ts";
import {
  ProjectDefinitionConflictError,
  StaleProjectDefinitionError,
  parseDefinitionMutation,
  sourceKey,
  type DefinitionIssueCode,
  type ProjectDefinitionMutation,
  type ProjectDefinitionState,
  type ProjectDefinitionOverride,
  type ProjectOwnedDefinition,
} from "./project-definition.ts";
import { resolveInstalledPacks } from "./resolve-installed-packs.ts";
import type { InstalledDomainPackCatalog } from "../ports/installed-domain-pack-catalog.port.ts";
import type { ProjectDefinitionRepository } from "../ports/project-definition-repository.port.ts";
import type { ProjectPackBindingRepository } from "../ports/project-pack-binding-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { AuditEventRepository } from "../ports/audit-event-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";

export interface ProjectDefinitionIssue {
  readonly code: DefinitionIssueCode;
  readonly message: string;
}
export interface ProjectDefinitionPreview {
  readonly current: ProjectDefinitionState;
  readonly mutation: ProjectDefinitionMutation;
  readonly affected: ProjectOwnedDefinition | ProjectDefinitionOverride | null;
  readonly source?: ProjectDefinitionOverride["source"];
  readonly ownershipTransition: string;
  readonly issues: readonly ProjectDefinitionIssue[];
}

export class ProjectDefinitionProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} does not exist`);
    this.name = "ProjectDefinitionProjectNotFoundError";
  }
}

export class ManageProjectDefinitions {
  constructor(
    private readonly dependencies: {
      projects: ProjectRepository;
      definitions: ProjectDefinitionRepository;
      bindings: ProjectPackBindingRepository;
      catalog: InstalledDomainPackCatalog;
      auditEvents: AuditEventRepository;
      transactions: TransactionRunner;
      clock: Clock;
      ids: IdGenerator;
    },
  ) {}

  async read(projectId: string): Promise<ProjectDefinitionState> {
    if (!(await this.dependencies.projects.findById(projectId)))
      throw new ProjectDefinitionProjectNotFoundError(projectId);
    return this.dependencies.definitions.get(projectId);
  }

  private async sourceBindingIssues(
    projectId: string,
    item: ProjectDefinitionOverride,
  ): Promise<ProjectDefinitionIssue[]> {
    const binding = await this.dependencies.bindings.get(projectId);
    const selected = binding.packs.find((pack) => pack.id === item.source.id);
    if (!selected || selected.version !== item.source.version)
      return [
        {
          code: "source_pack_not_selected",
          message: `Pack ${item.source.id}@${item.source.version} is not selected`,
        },
      ];
    if (selected.manifestDigest !== item.source.manifestDigest)
      return [
        {
          code: "source_digest_mismatch",
          message: `Selected manifest digest differs for ${item.source.id}@${item.source.version}`,
        },
      ];
    return [];
  }

  private async sourceIssues(
    projectId: string,
    item: ProjectDefinitionOverride,
  ): Promise<ProjectDefinitionIssue[]> {
    const bindingIssues = await this.sourceBindingIssues(projectId, item);
    if (bindingIssues.length > 0) return bindingIssues;
    const binding = await this.dependencies.bindings.get(projectId);
    try {
      resolveInstalledPacks(this.dependencies.catalog, binding.packs);
      const artifact = this.dependencies.catalog.read(
        item.source.id,
        item.source.version,
      );
      if (!artifact)
        return [
          {
            code: "source_unavailable",
            message: `Pack ${item.source.id}@${item.source.version} is unavailable`,
          },
        ];
      const manifest = verifyDomainPackManifest(artifact.bytes);
      const source = manifest.contributions[item.source.kind].find(
        (entry) => entry.id === item.source.localId,
      );
      if (!source)
        return [
          {
            code: "source_definition_missing",
            message: `Definition ${item.source.kind}/${item.source.localId} is missing from exact source`,
          },
        ];
      if (item.operation === "extend" && item.payload) {
        for (const key of ["title", "description"] as const)
          if (item.payload[key] !== undefined && source[key] !== undefined)
            return [
              {
                code: "protected_security_invariant",
                message: `extend cannot replace source ${key}`,
              },
            ];
      }
      return [];
    } catch (error) {
      return [
        {
          code: "source_unavailable",
          message:
            error instanceof Error ? error.message : "Pack source unavailable",
        },
      ];
    }
  }

  async inspect(projectId: string): Promise<{
    state: ProjectDefinitionState;
    issues: readonly (ProjectDefinitionIssue & {
      source: ProjectDefinitionOverride["source"];
    })[];
  }> {
    const state = await this.read(projectId);
    const issues = [];
    for (const item of state.overrides)
      for (const issue of await this.sourceIssues(projectId, item))
        issues.push({ ...issue, source: item.source });
    return { state, issues };
  }

  private async previewParsed(
    projectId: string,
    mutation: ProjectDefinitionMutation,
    current: ProjectDefinitionState,
    checkInstalledSource = true,
  ): Promise<ProjectDefinitionPreview> {
    const issues: ProjectDefinitionIssue[] = [];
    const affected =
      mutation.action === "put_owned" || mutation.action === "remove_owned"
        ? (current.owned.find(
            (item) => item.kind === mutation.kind && item.id === mutation.id,
          ) ?? null)
        : (current.overrides.find(
            (item) => sourceKey(item.source) === sourceKey(mutation.source),
          ) ?? null);
    if (mutation.action === "put_owned" || mutation.action === "put_override") {
      const expected = mutation.expectedEntryRevision;
      if (affected && expected === undefined)
        issues.push({
          code:
            mutation.action === "put_owned"
              ? "duplicate_project_definition"
              : "duplicate_override_target",
          message:
            "Entry already exists; revise with its exact expectedEntryRevision",
        });
      if (affected && expected !== undefined && affected.revision !== expected)
        issues.push({
          code: "conflicting_ownership_metadata",
          message: "Entry revision differs from expectedEntryRevision",
        });
      if (!affected && expected !== undefined)
        issues.push({
          code: "conflicting_ownership_metadata",
          message: "No entry exists for expectedEntryRevision",
        });
    } else if (!affected)
      issues.push({
        code: "conflicting_ownership_metadata",
        message: "Entry does not exist",
      });
    if (mutation.action === "put_override") {
      const candidate: ProjectDefinitionOverride = {
        origin: "project_override",
        source: mutation.source,
        operation: mutation.operation,
        revision: 1,
        ...(mutation.payload === undefined
          ? {}
          : { payload: mutation.payload }),
        actorId: "preview",
        changedAt: "1970-01-01T00:00:00.000Z",
      };
      issues.push(
        ...(await (checkInstalledSource
          ? this.sourceIssues(projectId, candidate)
          : this.sourceBindingIssues(projectId, candidate))),
      );
    }
    return {
      current,
      mutation,
      affected,
      ...(mutation.action === "put_override" ||
      mutation.action === "remove_override"
        ? { source: mutation.source }
        : {}),
      ownershipTransition: mutation.action.startsWith("remove")
        ? `${affected?.origin ?? "missing"} -> absent`
        : affected
          ? `${affected.origin} -> ${affected.origin}`
          : `absent -> ${mutation.action === "put_owned" ? "project_owned" : "project_override"}`,
      issues,
    };
  }

  async preview(
    projectId: string,
    rawMutation: unknown,
  ): Promise<ProjectDefinitionPreview> {
    const mutation = parseDefinitionMutation(rawMutation);
    return this.previewParsed(projectId, mutation, await this.read(projectId));
  }

  async apply(input: {
    projectId: string;
    mutation: unknown;
    expectedRevision: number;
    actorId: string;
  }): Promise<ProjectDefinitionState> {
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      throw new ProjectDefinitionConflictError(
        "malformed_origin_reference",
        "expectedRevision must be nonnegative",
      );
    const mutation = parseDefinitionMutation(input.mutation);
    const preview = await this.preview(input.projectId, mutation);
    if (preview.current.revision !== input.expectedRevision)
      throw new StaleProjectDefinitionError(
        input.projectId,
        preview.current.revision,
      );
    if (preview.issues[0])
      throw new ProjectDefinitionConflictError(
        preview.issues[0].code,
        preview.issues[0].message,
      );
    return this.dependencies.transactions.run(async () => {
      const current = await this.dependencies.definitions.get(input.projectId);
      if (current.revision !== input.expectedRevision)
        throw new StaleProjectDefinitionError(
          input.projectId,
          current.revision,
        );
      const checked = await this.previewParsed(
        input.projectId,
        mutation,
        current,
        false,
      );
      if (checked.issues[0])
        throw new ProjectDefinitionConflictError(
          checked.issues[0].code,
          checked.issues[0].message,
        );
      const now = this.dependencies.clock.now();
      const changedAt = now.toISOString();
      let owned = [...current.owned];
      let overrides = [...current.overrides];
      if (mutation.action === "put_owned") {
        owned = owned.filter(
          (item) => item.kind !== mutation.kind || item.id !== mutation.id,
        );
        owned.push({
          origin: "project_owned",
          kind: mutation.kind,
          id: mutation.id,
          revision: (checked.affected?.revision ?? 0) + 1,
          enabled: mutation.enabled,
          payload: mutation.payload,
          actorId: input.actorId,
          changedAt,
        });
      } else if (mutation.action === "remove_owned")
        owned = owned.filter(
          (item) => item.kind !== mutation.kind || item.id !== mutation.id,
        );
      else if (mutation.action === "put_override") {
        overrides = overrides.filter(
          (item) => sourceKey(item.source) !== sourceKey(mutation.source),
        );
        overrides.push({
          origin: "project_override",
          source: mutation.source,
          operation: mutation.operation,
          revision: (checked.affected?.revision ?? 0) + 1,
          ...(mutation.payload === undefined
            ? {}
            : { payload: mutation.payload }),
          actorId: input.actorId,
          changedAt,
        });
      } else
        overrides = overrides.filter(
          (item) => sourceKey(item.source) !== sourceKey(mutation.source),
        );
      owned.sort((a, b) =>
        `${a.kind}/${a.id}`.localeCompare(`${b.kind}/${b.id}`),
      );
      overrides.sort((a, b) =>
        sourceKey(a.source).localeCompare(sourceKey(b.source)),
      );
      const result = await this.dependencies.definitions.replace(
        {
          projectId: input.projectId,
          revision: current.revision,
          owned,
          overrides,
        },
        input.expectedRevision,
        now,
      );
      await this.dependencies.auditEvents.append(
        AuditEvent.create({
          id: this.dependencies.ids.generate(),
          eventType: "project.definition_changed",
          actorType: "cli",
          actorId: input.actorId,
          aggregateType: "project",
          aggregateId: input.projectId,
          projectId: input.projectId,
          payload: {
            action: mutation.action,
            origin:
              mutation.action === "put_owned" ||
              mutation.action === "remove_owned"
                ? "project_owned"
                : "project_override",
            identity:
              mutation.action === "put_owned" ||
              mutation.action === "remove_owned"
                ? { kind: mutation.kind, id: mutation.id }
                : mutation.source,
            operation:
              mutation.action === "put_override"
                ? mutation.operation
                : mutation.action,
            previousRevision: current.revision,
            newRevision: result.revision,
            previousEntryRevision: checked.affected?.revision ?? null,
            newEntryRevision: mutation.action.startsWith("put")
              ? (checked.affected?.revision ?? 0) + 1
              : null,
          },
          occurredAt: now,
        }),
      );
      return result;
    });
  }
}
