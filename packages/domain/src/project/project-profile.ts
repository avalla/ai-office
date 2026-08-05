export type ProjectProfileOrigin = "detected" | "inferred" | "user";

export type ProjectAnswerCategory = "goal" | "preference" | "constraint" | "permission";

export const agentOperations = [
  "read_files",
  "modify_files",
  "run_tests",
  "run_shell",
  "install_dependencies",
  "create_branches",
  "create_commits",
  "network_access"
] as const;

export type AgentOperation = (typeof agentOperations)[number];

export interface TextProjectAnswer {
  category: Exclude<ProjectAnswerCategory, "permission">;
  value: string;
}

export interface PermissionProjectAnswer {
  category: "permission";
  value: {
    operations: AgentOperation[];
  };
}

export type ProjectAnswer = TextProjectAnswer | PermissionProjectAnswer;

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
}

export interface ProjectScanSummary {
  rootPath: string;
  projectName: string;
  remoteUrl?: string;
  currentBranch?: string;
  packageManager?: string;
  languages: string[];
  frameworks: string[];
  databases: string[];
  testing: string[];
  documentation: string[];
  detectedFiles: string[];
}
