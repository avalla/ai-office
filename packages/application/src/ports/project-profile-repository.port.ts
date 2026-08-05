import type {
  ProjectAnswer,
  ProjectAnswerCategory,
  ProjectProfileEntry,
  ProjectQuestion,
  ProjectScanSummary
} from "@ai-office/domain/project/project-profile.ts";

export interface ProjectSource {
  id: string;
  projectId: string;
  sourceType: "local";
  localPath: string;
  remoteUrl?: string;
  defaultBranch?: string;
  createdAt: Date;
}

export interface ProjectScan {
  id: string;
  projectId: string;
  scanType: "deterministic_quick_scan";
  status: "completed";
  startedAt: Date;
  completedAt: Date;
  sourceRevision?: string;
  summary: ProjectScanSummary;
}

export interface NewProjectQuestion {
  id: string;
  projectId: string;
  scanId: string;
  key: string;
  question: string;
  reason: string;
  answerCategory: ProjectAnswerCategory;
}

export interface ProjectProfileRepository {
  findProjectIdByLocalPath(localPath: string): Promise<string | null>;
  saveSource(source: ProjectSource): Promise<void>;
  saveScan(scan: ProjectScan): Promise<void>;
  replaceDetected(entries: ProjectProfileEntry[]): Promise<void>;
  ensureQuestions(questions: NewProjectQuestion[]): Promise<void>;
  findQuestion(projectId: string, questionId: string): Promise<ProjectQuestion | null>;
  listOpenQuestions(projectId: string): Promise<ProjectQuestion[]>;
  answerQuestion(questionId: string, answer: ProjectAnswer, answeredAt: Date): Promise<void>;
  saveProfileEntry(entry: ProjectProfileEntry): Promise<void>;
  listActiveProfileEntries(projectId: string): Promise<ProjectProfileEntry[]>;
}
