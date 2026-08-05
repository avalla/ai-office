import { Project } from "@ai-office/domain/project/project.ts";
import type {
  ProjectAnswerCategory,
  ProjectProfileEntry,
  ProjectScanSummary
} from "@ai-office/domain/project/project-profile.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { ProjectProfileRepository } from "../ports/project-profile-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { ProjectScanner } from "../ports/project-scanner.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";

export interface ImportProjectResult {
  projectId: string;
  created: boolean;
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
  return onboardingQuestionDefinitions(scan).map(({ question }) => question);
}

interface OnboardingQuestionDefinition {
  key: string;
  question: string;
  reason: string;
  answerCategory: ProjectAnswerCategory;
}

function onboardingQuestionDefinitions(scan: ProjectScanSummary): OnboardingQuestionDefinition[] {
  const questions: OnboardingQuestionDefinition[] = [
    {
      key: "next_outcome",
      question: "Qual è il prossimo risultato concreto che vuoi ottenere?",
      reason: "Definisce l'obiettivo operativo prioritario del progetto.",
      answerCategory: "goal"
    },
    {
      key: "agent_permissions",
      question: "Quali operazioni possono eseguire autonomamente gli agenti?",
      reason: "Stabilisce i confini operativi espliciti per gli agenti.",
      answerCategory: "permission"
    },
    {
      key: "architecture_constraints",
      question: "Quali vincoli architetturali o tecnologici non devono essere modificati?",
      reason: "Registra i vincoli che ogni modifica futura deve rispettare.",
      answerCategory: "constraint"
    }
  ];

  if (scan.testing.length === 0) {
    questions.push({
      key: "testing_strategy",
      question: "Quale strategia di test vuoi adottare per il progetto?",
      reason: "La scansione non ha rilevato strumenti di test.",
      answerCategory: "preference"
    });
  }

  if (scan.documentation.length === 0) {
    questions.push({
      key: "documentation_location",
      question: "Dove devono essere registrate decisioni e convenzioni del progetto?",
      reason: "La scansione non ha rilevato documentazione di progetto.",
      answerCategory: "preference"
    });
  }

  return questions;
}

export class ImportProject {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly profiles: ProjectProfileRepository,
    private readonly scanner: ProjectScanner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner
  ) {}

  async execute(input: { rootPath: string; name?: string }): Promise<ImportProjectResult> {
    const scanStartedAt = this.clock.now();
    const scan = await this.scanner.scan(input.rootPath);
    const completedAt = this.clock.now();

    return this.transactions.run(async () => {
      const existingProjectId = await this.profiles.findProjectIdByLocalPath(scan.rootPath);
      let projectId = existingProjectId;
      let created = false;

      if (projectId === null) {
        const project = Project.create({
          id: this.ids.generate(),
          name: input.name ?? scan.projectName,
          description: `Imported from ${scan.rootPath}`,
          now: completedAt
        });

        await this.projects.save(project);
        projectId = project.snapshot().id;
        created = true;
      }

      const scanId = this.ids.generate();
      await this.profiles.saveSource({
        id: this.ids.generate(),
        projectId,
        sourceType: "local",
        localPath: scan.rootPath,
        ...(scan.remoteUrl === undefined ? {} : { remoteUrl: scan.remoteUrl }),
        ...(scan.currentBranch === undefined ? {} : { defaultBranch: scan.currentBranch }),
        createdAt: completedAt
      });

      await this.profiles.saveScan({
        id: scanId,
        projectId,
        scanType: "deterministic_quick_scan",
        status: "completed",
        startedAt: scanStartedAt,
        completedAt,
        ...(scan.currentBranch === undefined ? {} : { sourceRevision: scan.currentBranch }),
        summary: scan
      });
      await this.profiles.replaceDetected(
        profileEntries(projectId, scan, this.ids, completedAt)
      );
      await this.profiles.ensureQuestions(
        onboardingQuestionDefinitions(scan).map((question) => ({
          id: this.ids.generate(),
          projectId,
          scanId,
          ...question
        }))
      );

      return {
        projectId,
        created,
        scan,
        questions: onboardingQuestions(scan)
      };
    });
  }
}
