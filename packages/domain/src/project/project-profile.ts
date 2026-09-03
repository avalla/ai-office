export type ProjectProfileOrigin = "detected" | "inferred" | "user";

export type ProjectAnswerCategory =
  "goal" | "preference" | "constraint" | "permission";

export type OnboardingQuestionSource = "deterministic" | "llm";

export type OnboardingAnswerType =
  "text" | "boolean" | "single_select" | "multi_select";

export const agentOperations = [
  "read_files",
  "modify_files",
  "run_tests",
  "run_shell",
  "install_dependencies",
  "create_branches",
  "create_commits",
  "network_access",
] as const;

export type AgentOperation = (typeof agentOperations)[number];

export interface TextProjectAnswer {
  category: Exclude<ProjectAnswerCategory, "permission">;
  value: string;
}

export interface BooleanProjectAnswer {
  category: Exclude<ProjectAnswerCategory, "permission">;
  value: boolean;
}

export interface SelectProjectAnswer {
  category: Exclude<ProjectAnswerCategory, "permission">;
  value: string | string[];
}

export interface PermissionProjectAnswer {
  category: "permission";
  value: {
    operations: AgentOperation[];
  };
}

export type ProjectAnswer =
  | TextProjectAnswer
  | BooleanProjectAnswer
  | SelectProjectAnswer
  | PermissionProjectAnswer;

export interface ProjectProfileEntry {
  id: string;
  projectId: string;
  category: string;
  key: string;
  value: unknown;
  origin: ProjectProfileOrigin;
  confidence: number;
  sourceReference?: string;
  confirmedAt?: Date;
  createdAt: Date;
}

export interface ProjectQuestion {
  id: string;
  projectId: string;
  scanId?: string;
  key: string;
  question: string;
  reason: string;
  answerCategory: ProjectAnswerCategory;
  answerType: OnboardingAnswerType;
  options?: string[];
  priority: number;
  source: OnboardingQuestionSource;
  generationId?: string;
  answer?: ProjectAnswer;
  answeredAt?: Date;
}

export interface ProjectProfileSnapshot {
  project: {
    id: string;
    name: string;
  };
  detectedFacts: ProjectProfileEntry[];
  inferences: ProjectProfileEntry[];
  confirmedPreferences: ProjectProfileEntry[];
  constraints: ProjectProfileEntry[];
  goals: ProjectProfileEntry[];
  permissions: ProjectProfileEntry[];
  openQuestions: ProjectQuestion[];
  generatedOnboardingQuestions: ProjectQuestion[];
}

export interface ProjectScanSummary {
  rootPath: string;
  projectName: string;
  remoteUrl?: string;
  currentBranch?: string;
  /**
   * Whether the checkout carries at least one commit. A checked-out branch
   * pointer is not history: `git init` produces one before any commit exists.
   * Absent on scans recorded before this evidence was collected.
   */
  hasCommitHistory?: boolean;
  packageManager?: string;
  languages: string[];
  frameworks: string[];
  databases: string[];
  testing: string[];
  documentation: string[];
  detectedFiles: string[];
}

/**
 * Extensions that count as application source code. Configuration, assets, and
 * documentation are deliberately excluded so repository scale reflects work
 * done rather than scaffolding.
 */
export const sourceFileExtensions: readonly string[] = Object.freeze([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".ex",
  ".exs",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
]);

export function countSourceFiles(files: readonly string[]): number {
  return files.filter((file) =>
    sourceFileExtensions.some((extension) => file.endsWith(extension)),
  ).length;
}
