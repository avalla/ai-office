import { AuditEvent } from "@ai-office/domain/event/audit-event.ts";
import {
  verifyDomainPackManifest,
  type DomainPackManifest,
} from "../../../domain-pack-contracts/src/index.ts";
import {
  ProjectDefinitionConflictError,
  StaleProjectDefinitionError,
  compareExactSources,
  compareOwnedDefinitions,
  parseDefinitionMutation,
  sourceKey,
  type AgentDefinition,
  type DefinitionIssueCode,
  type WorkflowDefinition,
  type ProjectDefinitionMutation,
  type ProjectDefinitionState,
  type ProjectDefinitionOverride,
  type ProjectOwnedDefinition,
} from "./project-definition.ts";
import { resolveInstalledPacks } from "./resolve-installed-packs.ts";
import {
  CapturedPackManifestError,
  resolveInstalledPackManifests,
} from "./resolve-installed-pack-manifests.ts";
import {
  DomainPackCatalogError,
  type InstalledDomainPackCatalog,
} from "../ports/installed-domain-pack-catalog.port.ts";
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

function installedSourceIssue(error: unknown): ProjectDefinitionIssue {
  if (error instanceof DomainPackCatalogError) {
    switch (error.code) {
      case "untrusted_provenance":
        return {
          code: "source_untrusted",
          message: "Installed pack provenance is not trusted",
        };
      case "incompatible_core_contract":
        return {
          code: "source_incompatible_core",
          message: "Installed pack is incompatible with this core contract",
        };
      case "missing_dependency":
        return {
          code: "source_dependency_unavailable",
          message: "A selected pack dependency is unavailable",
        };
      case "dependency_digest_mismatch":
      case "version_conflict":
      case "duplicate_conflict":
      case "dependency_cycle":
      case "malformed_dependency_graph":
        return {
          code: "source_dependency_conflict",
          message: "Selected pack dependencies conflict",
        };
      case "manifest_digest_mismatch":
      case "artifact_digest_mismatch":
        return {
          code: "source_digest_mismatch",
          message: "Installed pack content differs from its declared digest",
        };
      case "unsupported_schema":
      case "malformed_catalog_entry":
        return {
          code: "source_incompatible_contract",
          message: "Installed pack contract cannot be verified",
        };
      case "missing_pack":
      case "malformed_request":
        break;
    }
  }
  return {
    code: "source_unavailable",
    message: "Installed pack source cannot be verified",
  };
}

/**
 * GP-06 rejects an agent whose references do not resolve in its own pack or
 * whose requested capabilities exceed its role's declared set. Report that
 * for a replacement before it is stored, against the exact source manifest.
 * Whether a referenced definition is disabled depends on the other project
 * entries and stays with the resolver.
 */
function agentReferenceIssues(
  manifest: DomainPackManifest,
  payload: AgentDefinition,
): ProjectDefinitionIssue[] {
  const agent = `agents/${payload.id}`;
  const missing = (
    kind: "roles" | "prompts" | "knowledge" | "capabilities",
    localId: string,
  ): ProjectDefinitionIssue[] =>
    manifest.contributions[kind].some((entry) => entry.id === localId)
      ? []
      : [
          {
            code: "source_definition_missing",
            message: `Agent ${agent} references ${kind}/${localId}, which is missing from exact source`,
          },
        ];
  const declared =
    manifest.contributions.roles.find((role) => role.id === payload.role)
      ?.capabilities ?? [];
  return [
    ...(payload.role === undefined ? [] : missing("roles", payload.role)),
    ...(payload.prompts ?? []).flatMap((id) => missing("prompts", id)),
    ...(payload.knowledge ?? []).flatMap((id) => missing("knowledge", id)),
    ...(payload.capabilities ?? []).flatMap((id) => {
      const issues = missing("capabilities", id);
      return issues.length > 0 ||
        declared.some((capability) => capability === id)
        ? issues
        : [
            {
              code: "agent_capability_exceeds_role" as const,
              message: `Agent ${agent} requests capabilities/${id} outside the declared set of its role roles/${payload.role}`,
            },
          ];
    }),
  ];
}

/**
 * GP-06 rejects a workflow whose task type or stage roles do not resolve in
 * its own pack. Report that for a replacement before it is stored, against
 * the exact source manifest, in envelope order and once per missing
 * reference. Whether a referenced role is omitted depends on the other
 * project entries and stays with the resolver.
 */
function workflowReferenceIssues(
  manifest: DomainPackManifest,
  payload: WorkflowDefinition,
): ProjectDefinitionIssue[] {
  const workflow = `workflows/${payload.id}`;
  const missing = (
    kind: "taskTypes" | "roles",
    localId: string,
  ): ProjectDefinitionIssue[] =>
    manifest.contributions[kind].some((entry) => entry.id === localId)
      ? []
      : [
          {
            code: "source_definition_missing",
            message: `Workflow ${workflow} references ${kind}/${localId}, which is missing from exact source`,
          },
        ];
  // Several stages may name one role; a missing role is one finding.
  const roles = [...new Set(payload.stages.map((stage) => stage.role))];
  return [
    ...missing("taskTypes", payload.taskType),
    ...roles.flatMap((role) => missing("roles", role)),
  ];
}

/**
 * A stored override is untrusted input: it may have arrived without the
 * mutation contract, for example in a database edited by hand. Re-check it
 * with the parser the GP-06 resolver uses for stored state, so a malformed
 * entry is reported as what it is and not as an unavailable pack.
 */
function storedOverrideIssues(
  item: ProjectDefinitionOverride,
): ProjectDefinitionIssue[] {
  try {
    parseDefinitionMutation({
      action: "put_override",
      source: item.source,
      operation: item.operation,
      ...(item.payload === undefined ? {} : { payload: item.payload }),
    });
    return [];
  } catch (error) {
    if (!(error instanceof ProjectDefinitionConflictError)) throw error;
    return [
      {
        code: error.code,
        message: `Stored override violates the override contract: ${error.message}`,
      },
    ];
  }
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

  /**
   * GP-06 rejects a project-owned entry whose kind and local ID also exist in
   * the resolved pack closure. Report that before the mutation is accepted,
   * over the same closure and exact code-unit identity. A closure that cannot
   * be resolved is already unresolvable and is not this mutation's conflict.
   */
  private async ownedCollisionIssues(
    projectId: string,
    mutation: Extract<ProjectDefinitionMutation, { action: "put_owned" }>,
  ): Promise<ProjectDefinitionIssue[]> {
    const binding = await this.dependencies.bindings.get(projectId);
    let closure;
    try {
      closure = resolveInstalledPackManifests(
        this.dependencies.catalog,
        binding.packs,
      );
    } catch (error) {
      if (
        error instanceof DomainPackCatalogError ||
        error instanceof CapturedPackManifestError
      )
        return [];
      throw error;
    }
    const colliding = closure
      .filter(({ manifest }) =>
        manifest.contributions[mutation.kind].some(
          (entry) => entry.id === mutation.id,
        ),
      )
      .map(({ identity }) => `${identity.id}@${identity.version}`)
      .sort();
    return colliding[0] === undefined
      ? []
      : [
          {
            code: "pack_definition_collision",
            message: `Project definition ${mutation.kind}/${mutation.id} collides with pack ${colliding[0]} in the resolved pack closure`,
          },
        ];
  }

  private async sourceIssues(
    projectId: string,
    item: ProjectDefinitionOverride,
  ): Promise<ProjectDefinitionIssue[]> {
    // Shape first: the checks below read the payload as its kind's envelope.
    const contractIssues = storedOverrideIssues(item);
    if (contractIssues.length > 0) return contractIssues;
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
      if (
        item.operation === "replace" &&
        item.source.kind === "agents" &&
        item.payload
      )
        return agentReferenceIssues(manifest, item.payload);
      if (
        item.operation === "replace" &&
        item.source.kind === "workflows" &&
        item.payload
      )
        // storedOverrideIssues established the workflow envelope above.
        return workflowReferenceIssues(
          manifest,
          item.payload as WorkflowDefinition,
        );
      return [];
    } catch (error) {
      return [installedSourceIssue(error)];
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
    if (mutation.action === "put_owned" && checkInstalledSource)
      issues.push(...(await this.ownedCollisionIssues(projectId, mutation)));
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
      owned.sort(compareOwnedDefinitions);
      overrides.sort((a, b) => compareExactSources(a.source, b.source));
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
