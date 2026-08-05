import { Project } from "@ai-office/domain/project/project.ts";
import type { ProjectProfileEntry, ProjectScanSummary } from "@ai-office/domain/project/project-profile.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { ProjectProfileRepository } from "../ports/project-profile-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { ProjectScanner } from "../ports/project-scanner.port.ts";

export interface ImportProjectResult {
  projectId: string;
  scan: ProjectScanSummary;
  questions: string[];
}

function profileEntries(
  projectId: string,
  scan: ProjectScanSummary,
  ids: IdGenerator,
  now: Date
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
    ["documentation", "files", scan.documentation, "repository scan"]
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
      createdAt: now
    }));
}

function onboardingQuestions(scan: ProjectScanSummary): string[] {
  const questions = [
    "Qual è il prossimo risultato concreto che vuoi ottenere?",
    "Quali operazioni possono eseguire autonomamente gli agenti?",
    "Quali vincoli architetturali o tecnologici non devono essere modificati?"
  ];

  if (scan.testing.length === 0) {
    questions.push("Quale strategia di test vuoi adottare per il progetto?");
  }

  if (scan.documentation.length === 0) {
    questions.push("Dove devono essere registrate decisioni e convenzioni del progetto?");
  }

  return questions;
}

export class ImportProject {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly profiles: ProjectProfileRepository,
    private readonly scanner: ProjectScanner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock
  ) {}

  async execute(input: { rootPath: string; name?: string }): Promise<ImportProjectResult> {
    const scan = await this.scanner.scan(input.rootPath);
    const now = this.clock.now();
    const project = Project.create({
      id: this.ids.generate(),
      name: input.name ?? scan.projectName,
      description: `Imported from ${scan.rootPath}`,
      now
    });

    await this.projects.save(project);
    await this.profiles.saveMany(profileEntries(project.snapshot().id, scan, this.ids, now));

    return {
      projectId: project.snapshot().id,
      scan,
      questions: onboardingQuestions(scan)
    };
  }
}
