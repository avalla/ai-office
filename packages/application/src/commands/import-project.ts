import { Project } from "@ai-office/domain/project/project.ts";
import type {
  ProjectProfileEntry,
  ProjectScanSummary,
} from "@ai-office/domain/project/project-profile.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { ProjectProfileRepository } from "../ports/project-profile-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { ProjectScanner } from "../ports/project-scanner.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import type { RepositoryIdentityRepository } from "../ports/repository-identity-repository.port.ts";

export interface ImportProjectResult {
  projectId: string;
  created: boolean;
  scan: ProjectScanSummary;
  questions: string[];
}

export class ProjectSourceAssociationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectSourceAssociationError";
  }
}

function normalizedRemote(value: string): string {
  return value
    .trim()
    .replace(/\/?\.git$/u, "")
    .replace(/\/$/u, "");
}

function profileEntries(
  projectId: string,
  scan: ProjectScanSummary,
  ids: IdGenerator,
  now: Date,
): ProjectProfileEntry[] {
  const detected: Array<[string, string, unknown, string | undefined]> = [
    ["repository", "root_path", scan.rootPath, scan.rootPath],
    ["repository", "remote_url", scan.remoteUrl, ".git/config"],
    ["repository", "current_branch", scan.currentBranch, ".git/HEAD"],
    ["tooling", "package_manager", scan.packageManager, "lockfile"],
    ["stack", "languages", scan.languages, "file extensions"],
    ["stack", "frameworks", scan.frameworks, "manifest files"],
    ["stack", "databases", scan.databases, "configuration files"],
    ["quality", "testing", scan.testing, "manifest files"],
    ["documentation", "files", scan.documentation, "repository scan"],
  ];

  return detected
    .filter(([, , value]) => value !== undefined)
    .map(([category, key, value, sourceReference]) => ({
      id: ids.generate(),
      projectId,
      category,
      key,
      value,
      origin: "detected" as const,
      confidence: 1,
      ...(sourceReference === undefined ? {} : { sourceReference }),
      confirmedAt: now,
      createdAt: now,
    }));
}

export class ImportProject {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly profiles: ProjectProfileRepository,
    private readonly scanner: ProjectScanner,
    private readonly identities: RepositoryIdentityRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(input: {
    rootPath: string;
    name?: string;
    projectId?: string;
    repositoryId?: string;
  }): Promise<ImportProjectResult> {
    const scanStartedAt = this.clock.now();
    const scan = await this.scanner.scan(input.rootPath);
    const completedAt = this.clock.now();

    if (input.projectId !== undefined) {
      const project = await this.projects.findById(input.projectId);
      if (project === null)
        throw new ProjectSourceAssociationError(
          `Project ${input.projectId} does not exist for repository association`,
        );
      const sources = await this.profiles.listSources(input.projectId);
      if (sources.length > 0) {
        const knownRemotes = sources
          .flatMap((source) =>
            source.remoteUrl === undefined ? [] : [source.remoteUrl],
          )
          .map(normalizedRemote);
        if (
          scan.remoteUrl === undefined ||
          knownRemotes.length === 0 ||
          !knownRemotes.includes(normalizedRemote(scan.remoteUrl))
        )
          throw new ProjectSourceAssociationError(
            `Repository identity is already associated with project ${input.projectId}, but this checkout cannot be verified as the same Git remote. Use a distinct repository identity or resolve the copied binding explicitly.`,
          );
      }
    }

    return this.transactions.run(async () => {
      const existingProjectId = await this.profiles.findProjectIdByLocalPath(
        scan.rootPath,
      );
      if (
        input.projectId !== undefined &&
        existingProjectId !== null &&
        existingProjectId !== input.projectId
      )
        throw new ProjectSourceAssociationError(
          `Canonical path ${scan.rootPath} is already associated with project ${existingProjectId}`,
        );
      let projectId = input.projectId ?? existingProjectId;
      let created = false;

      if (projectId === null) {
        const project = Project.create({
          id: this.ids.generate(),
          name: input.name ?? scan.projectName,
          description: `Imported from ${scan.rootPath}`,
          now: completedAt,
        });

        await this.projects.save(project);
        projectId = project.snapshot().id;
        const association = await this.identities.associate({
          repositoryId: input.repositoryId ?? `repo_${projectId}`,
          projectId,
          createdAt: completedAt,
        });
        if (association !== "created")
          throw new ProjectSourceAssociationError(
            `Portable identity for imported project ${projectId} conflicts`,
          );
        created = true;
      }

      const scanId = this.ids.generate();
      await this.profiles.saveSource({
        id: this.ids.generate(),
        projectId,
        sourceType: "local",
        localPath: scan.rootPath,
        ...(scan.remoteUrl === undefined ? {} : { remoteUrl: scan.remoteUrl }),
        ...(scan.currentBranch === undefined
          ? {}
          : { defaultBranch: scan.currentBranch }),
        createdAt: completedAt,
      });

      await this.profiles.saveScan({
        id: scanId,
        projectId,
        scanType: "deterministic_quick_scan",
        status: "completed",
        startedAt: scanStartedAt,
        completedAt,
        ...(scan.currentBranch === undefined
          ? {}
          : { sourceRevision: scan.currentBranch }),
        summary: scan,
      });
      await this.profiles.replaceDetected(
        profileEntries(projectId, scan, this.ids, completedAt),
      );
      return {
        projectId,
        created,
        scan,
        questions: [],
      };
    });
  }
}
