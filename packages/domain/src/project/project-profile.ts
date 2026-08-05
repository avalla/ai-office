export type ProjectProfileOrigin = "detected" | "inferred" | "user";

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
