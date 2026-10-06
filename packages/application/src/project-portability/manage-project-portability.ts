import { Project } from "@ai-office/domain/project/project.ts";
import {
  parseDomainPackId,
  parseDomainPackVersion,
  parseManifestDigest,
} from "../../../domain-pack-contracts/src/index.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { InstalledDomainPackCatalog } from "../ports/installed-domain-pack-catalog.port.ts";
import {
  packDefinitionCollision,
  packDefinitionCollisions,
  resolvablePackClosure,
  type PackDefinitionCollision,
} from "../domain-pack/pack-definition-collisions.ts";
import type { ProjectBindingAdapter } from "../ports/project-binding-adapter.port.ts";
import type { ProjectProfileRepository } from "../ports/project-profile-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { ProjectScanner } from "../ports/project-scanner.port.ts";
import type {
  ProjectPortabilityBlocker,
  ProjectStateRepository,
} from "../ports/project-state-repository.port.ts";
import type { RepositoryIdentityRepository } from "../ports/repository-identity-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import {
  ProjectBindingError,
  repositoryIdFromLegacyProjectId,
} from "../project-lifecycle/project-binding.ts";
import {
  createPortableProjectArchive,
  portableProjectFormatVersionFor,
  portableProjectManifestFor,
  portableStateAtFormatVersion,
  portableStateChecksum,
  type PortableProjectArchive,
  type PortableProjectManifest,
} from "./project-snapshot.ts";
import {
  comparablePortableGitRemote,
  selectPortableGitProvenance,
} from "./project-git-provenance.ts";

export class ProjectPortabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectPortabilityError";
  }
}

export class ProjectRestorePartialError extends ProjectPortabilityError {
  constructor(
    readonly result: {
      schemaVersion: 1;
      outcome: "partial";
      projectIdentity: string;
      projectId: string;
      rootPath: string;
      revisionId: string;
      error: { message: string; recovery: string };
    },
  ) {
    super(`${result.error.message} ${result.error.recovery}`);
    this.name = "ProjectRestorePartialError";
  }
}

/**
 * The archive's sections are valid one by one, but its exact pack closure,
 * resolved on this host, contains a definition a project-owned definition of
 * the archive also declares (GP-22). Nothing was restored. The code is the one
 * binding preview and apply report for the same conflict.
 */
export class ProjectRestoreCompositionError extends ProjectPortabilityError {
  readonly code = packDefinitionCollision;
  constructor(readonly collisions: readonly PackDefinitionCollision[]) {
    const first = collisions[0]!;
    super(
      `Portable restore rejected (${packDefinitionCollision}): project definition ${first.kind}/${first.id} collides with pack ${first.pack} in the archive's resolved pack closure; nothing was restored`,
    );
    this.name = "ProjectRestoreCompositionError";
  }
}

function normalizedRemote(value: string): string {
  return value
    .trim()
    .replace(/\/?\.git$/u, "")
    .replace(/\/$/u, "");
}

function describeBlocker(blocker: ProjectPortabilityBlocker): string {
  switch (blocker.kind) {
    case "agent_run":
      return `Active agent run ${blocker.runId}: ${blocker.status} (task ${blocker.taskId})`;
    case "pipeline_run":
      return `Active pipeline ${blocker.pipelineRunId} (task ${blocker.taskId})`;
    case "task_lock":
      return `Active task lock for task ${blocker.taskId} (run ${blocker.runId}, expires ${blocker.expiresAt.toISOString()})`;
  }
}

function portabilityBlocked(
  blockers: ProjectPortabilityBlocker[],
): ProjectPortabilityError {
  return new ProjectPortabilityError(
    [
      "Cannot create portable backup while project has active execution state.",
      "",
      ...blockers.map(describeBlocker),
      "",
      "Finish or cancel active work before retrying project:backup.",
    ].join("\n"),
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown restore failure";
}

export interface ProjectBackupResult {
  schemaVersion: 1;
  projectId: string;
  projectIdentity: string;
  revisionId: string;
  parentRevisionId: string | null;
  stateChecksum: string;
  archive: PortableProjectArchive;
}

export interface ProjectRestoreResult {
  schemaVersion: 1;
  outcome: "restored" | "attached" | "unchanged";
  projectId: string;
  projectIdentity: string;
  rootPath: string;
  revisionId: string;
  stateChecksum: string;
  repositoryIdentityAction: "create" | "update" | "none";
}

interface Dependencies {
  projects: ProjectRepository;
  profiles: ProjectProfileRepository;
  identities: RepositoryIdentityRepository;
  states: ProjectStateRepository;
  bindings: ProjectBindingAdapter;
  scanner: ProjectScanner;
  transactions: TransactionRunner;
  ids: IdGenerator;
  clock: Clock;
  /** Host-local availability; read by restore's composition preflight only. */
  catalog: InstalledDomainPackCatalog;
}

export class ManageProjectPortability {
  constructor(private readonly dependencies: Dependencies) {}

  async backup(projectId: string): Promise<ProjectBackupResult> {
    const project = await this.dependencies.projects.findById(projectId);
    if (project === null)
      throw new ProjectPortabilityError(`Project ${projectId} does not exist`);
    const projectIdentity =
      await this.dependencies.identities.findRepositoryId(projectId);
    if (projectIdentity === null)
      throw new ProjectPortabilityError(
        `Project ${projectId} has no portable identity; run ai-office install . first`,
      );

    const source = selectPortableGitProvenance(
      await this.dependencies.profiles.listSources(projectId),
    );
    const now = this.dependencies.clock.now();
    return this.dependencies.transactions.run(async () => {
      const blockers = await this.dependencies.states.findPortabilityBlockers(
        projectId,
        now,
      );
      if (blockers.length > 0) throw portabilityBlocked(blockers);
      const state = await this.dependencies.states.loadPortableState(projectId);
      if (state.taskExecutionHistory === undefined)
        throw new ProjectPortabilityError(
          "Portable backup requires explicit lifetime task execution knowledge",
        );
      const stateChecksum = portableStateChecksum(state);
      const head = await this.dependencies.states.findHead(projectId);
      const revision =
        head?.revision.stateChecksum === stateChecksum
          ? head.revision
          : {
              id: `rev_${this.dependencies.ids.generate()}`,
              projectId,
              ...(head === null ? {} : { parentRevisionId: head.revision.id }),
              stateChecksum,
              origin: "local_snapshot" as const,
              createdAt: now,
            };
      // New snapshots carry explicit lifetime execution knowledge (v4).
      const manifest: PortableProjectManifest = portableProjectManifestFor({
        formatVersion: portableProjectFormatVersionFor(state),
        projectIdentity,
        createdAt: revision.createdAt.toISOString(),
        revision: {
          id: revision.id,
          ...(revision.parentRevisionId === undefined
            ? {}
            : { parentRevisionId: revision.parentRevisionId }),
          stateChecksum: revision.stateChecksum,
        },
        ...(source === undefined ? {} : { source }),
      });
      const archive = createPortableProjectArchive({ manifest, state });
      if (head?.revision.stateChecksum !== stateChecksum)
        await this.dependencies.states.saveRevision(
          revision,
          head?.baseRevisionId,
        );
      return {
        schemaVersion: 1,
        projectId,
        projectIdentity,
        revisionId: revision.id,
        parentRevisionId: revision.parentRevisionId ?? null,
        stateChecksum: revision.stateChecksum,
        archive,
      };
    });
  }

  async restore(input: {
    archive: PortableProjectArchive;
    rootPath: string;
  }): Promise<ProjectRestoreResult> {
    const { archive } = input;
    const resolvedRoot = await this.dependencies.bindings.resolveProjectRoot(
      input.rootPath,
    );
    const inspection = await this.dependencies.bindings.inspect(resolvedRoot);
    if (inspection.status === "invalid")
      throw new ProjectBindingError(
        inspection.issue ?? "Repository identity is invalid",
      );
    const rootPath = inspection.rootPath;
    const bindingIdentity =
      inspection.binding?.schemaVersion === 1
        ? repositoryIdFromLegacyProjectId(inspection.binding.projectId)
        : inspection.binding?.repositoryId;
    if (
      bindingIdentity !== undefined &&
      bindingIdentity !== archive.manifest.projectIdentity
    )
      throw new ProjectPortabilityError(
        `Repository identity ${bindingIdentity} does not match archive project ${archive.manifest.projectIdentity}`,
      );

    const bindingPlan = await this.dependencies.bindings.planWrite(rootPath, {
      schemaVersion: 2,
      managedBy: "ai-office",
      repositoryId: archive.manifest.projectIdentity,
    });
    const scan = await this.dependencies.scanner.scan(rootPath);
    if (
      bindingIdentity === undefined &&
      archive.manifest.source?.type === "git" &&
      archive.manifest.source.remote !== undefined &&
      comparablePortableGitRemote(scan.remoteUrl) !==
        comparablePortableGitRemote(archive.manifest.source.remote)
    )
      throw new ProjectPortabilityError(
        "Target checkout Git remote does not match the archive source provenance",
      );
    const pathProject =
      await this.dependencies.profiles.findProjectIdByLocalPath(rootPath);
    const identityProject = await this.dependencies.identities.findProjectId(
      archive.manifest.projectIdentity,
    );
    if (
      pathProject !== null &&
      identityProject !== null &&
      pathProject !== identityProject
    )
      throw new ProjectPortabilityError(
        `Target path belongs to project ${pathProject}, but archive identity belongs to ${identityProject}`,
      );
    if (pathProject !== null && identityProject === null)
      throw new ProjectPortabilityError(
        `Target path is already registered to unrelated project ${pathProject}`,
      );

    if (identityProject !== null && pathProject === null) {
      const sources =
        await this.dependencies.profiles.listSources(identityProject);
      const knownRemotes = sources.flatMap((source) =>
        source.remoteUrl === undefined
          ? []
          : [normalizedRemote(source.remoteUrl)],
      );
      if (
        knownRemotes.length > 0 &&
        (scan.remoteUrl === undefined ||
          !knownRemotes.includes(normalizedRemote(scan.remoteUrl)))
      )
        throw new ProjectPortabilityError(
          `Archive identity is already known, but target checkout does not match a known Git remote`,
        );
      if (knownRemotes.length === 0 && sources.length > 0)
        throw new ProjectPortabilityError(
          "Archive identity is already known, but another checkout cannot be verified without common Git remote evidence",
        );
    }

    // GP-22. Only a restore that creates the project writes binding and
    // definition state; `attached` and `unchanged` write neither and are not
    // checked, so a rerun after a partial failure stays possible. The closure
    // is resolved here, before and outside the transaction.
    if (identityProject === null) this.assertArchiveComposition(archive);

    let projectId = identityProject;
    let outcome: ProjectRestoreResult["outcome"] = "restored";
    let authoritativeStateCommitted = false;
    let shouldRecordImportedRevision = false;
    const now = this.dependencies.clock.now();
    try {
      await this.dependencies.transactions.run(async () => {
        if (projectId === null) {
          projectId = this.dependencies.ids.generate();
          await this.dependencies.projects.save(
            Project.restore({
              id: projectId,
              name: archive.state.project.name,
              ...(archive.state.project.description === undefined
                ? {}
                : { description: archive.state.project.description }),
              createdAt: new Date(archive.state.project.createdAt),
              updatedAt: new Date(archive.state.project.updatedAt),
            }),
          );
          const associated = await this.dependencies.identities.associate({
            repositoryId: archive.manifest.projectIdentity,
            projectId,
            createdAt: now,
          });
          if (associated !== "created")
            throw new ProjectPortabilityError(
              "Portable project identity changed during restore",
            );
          await this.dependencies.states.restorePortableState(
            projectId,
            archive.state,
          );
          shouldRecordImportedRevision = true;
        } else {
          const local =
            await this.dependencies.states.loadPortableState(projectId);
          if (
            portableStateChecksum(
              portableStateAtFormatVersion(
                local,
                archive.manifest.formatVersion,
              ),
            ) !== archive.manifest.revision.stateChecksum
          )
            throw new ProjectPortabilityError(
              `Restore conflict: local authoritative state differs from archive revision ${archive.manifest.revision.id}; restore will not overwrite it`,
            );
          const localHead = await this.dependencies.states.findHead(projectId);
          if (
            localHead !== null &&
            localHead.revision.id !== archive.manifest.revision.id
          )
            throw new ProjectPortabilityError(
              `Restore conflict: local head ${localHead.revision.id} and archive head ${archive.manifest.revision.id} have different revision history; restore will not move the local head`,
            );
          if (
            localHead !== null &&
            (localHead.revision.parentRevisionId !==
              archive.manifest.revision.parentRevisionId ||
              localHead.revision.createdAt.toISOString() !==
                archive.manifest.createdAt)
          )
            throw new ProjectPortabilityError(
              `Restore conflict: revision ${archive.manifest.revision.id} metadata does not match the local immutable revision`,
            );
          shouldRecordImportedRevision = localHead === null;
          outcome = pathProject === null ? "attached" : "unchanged";
        }

        await this.dependencies.profiles.saveSource({
          id: this.dependencies.ids.generate(),
          projectId,
          sourceType: "local",
          localPath: scan.rootPath,
          ...(scan.remoteUrl === undefined
            ? {}
            : { remoteUrl: scan.remoteUrl }),
          ...(scan.defaultBranch === undefined
            ? {}
            : { defaultBranch: scan.defaultBranch }),
          createdAt: now,
        });
        if (shouldRecordImportedRevision)
          await this.dependencies.states.saveRevision(
            {
              id: archive.manifest.revision.id,
              projectId,
              ...(archive.manifest.revision.parentRevisionId === undefined
                ? {}
                : {
                    parentRevisionId:
                      archive.manifest.revision.parentRevisionId,
                  }),
              stateChecksum: archive.manifest.revision.stateChecksum,
              origin: "portable_import",
              createdAt: new Date(archive.manifest.createdAt),
            },
            archive.manifest.revision.id,
          );
      });
      authoritativeStateCommitted = true;
      await this.dependencies.bindings.applyWrite(bindingPlan);
    } catch (error) {
      if (!authoritativeStateCommitted) throw error;
      if (projectId === null) throw error;
      const mapped = await this.dependencies.identities.findProjectId(
        archive.manifest.projectIdentity,
      );
      if (mapped !== projectId) throw error;
      if (error instanceof ProjectPortabilityError) throw error;
      throw new ProjectRestorePartialError({
        schemaVersion: 1,
        outcome: "partial",
        projectIdentity: archive.manifest.projectIdentity,
        projectId,
        rootPath,
        revisionId: archive.manifest.revision.id,
        error: {
          message: message(error),
          recovery:
            "Authoritative state was restored, but repository binding may be incomplete. Run ai-office status, then rerun the same restore after resolving the filesystem issue.",
        },
      });
    }

    if (projectId === null)
      throw new ProjectPortabilityError(
        "Portable project restore did not resolve a local project",
      );
    return {
      schemaVersion: 1,
      outcome,
      projectId,
      projectIdentity: archive.manifest.projectIdentity,
      rootPath,
      revisionId: archive.manifest.revision.id,
      stateChecksum: archive.manifest.revision.stateChecksum,
      repositoryIdentityAction: bindingPlan.action,
    };
  }

  /**
   * Compares the archive's own project-owned definitions with the exact pack
   * closure of the archive's own binding. Installed packs are host-local
   * state and never a prerequisite for restore: when the exact closure does
   * not resolve here, for any GP-04 reason, there is no verdict, the archive
   * restores unchanged and GP-06 reports the closure failure, and later a
   * collision, when the project configuration is resolved.
   */
  private assertArchiveComposition(archive: PortableProjectArchive): void {
    const owned = archive.state.definitions?.owned ?? [];
    // The archive schema already validated each tuple; this only restores
    // the exact types the resolver takes.
    const packs = (archive.state.packBinding?.packs ?? []).map((pack) => ({
      id: parseDomainPackId(pack.id),
      version: parseDomainPackVersion(pack.version),
      manifestDigest: parseManifestDigest(pack.manifestDigest),
    }));
    if (packs.length === 0 || owned.length === 0) return;
    const closure = resolvablePackClosure(this.dependencies.catalog, packs);
    if (closure === undefined) return;
    const collisions = packDefinitionCollisions(closure, owned);
    if (collisions.length > 0)
      throw new ProjectRestoreCompositionError(collisions);
  }
}
