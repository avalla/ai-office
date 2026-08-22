export type RuntimePurgeArtifactKind =
  "file" | "directory" | "socket" | "symbolic_link";

export interface RuntimePurgeArtifact {
  relativePath: string;
  kind: RuntimePurgeArtifactKind;
  sizeBytes: number;
  fingerprint: string;
}

export interface RuntimePurgeDraft {
  contractVersion: 1;
  runtimeRoot: string;
  stateDirectory: string;
  stateDirectoryFingerprint: string | null;
  artifacts: readonly RuntimePurgeArtifact[];
  preservedPaths: readonly string[];
}

export interface RuntimePurgeResult {
  runtimeRoot: string;
  removedPaths: readonly string[];
  preservedPaths: readonly string[];
  stateDirectoryRemoved: boolean;
}

export interface RuntimePurgeAdapter {
  plan(runtimeRoot: string): Promise<RuntimePurgeDraft>;
  apply(draft: RuntimePurgeDraft): Promise<RuntimePurgeResult>;
}
