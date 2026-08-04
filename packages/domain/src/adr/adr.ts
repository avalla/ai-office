export type AdrStatus = "proposed" | "accepted" | "rejected" | "deprecated" | "superseded";

export interface ArchitectureDecision {
  id: string;
  projectId: string;
  title: string;
  context: string;
  decision: string;
  consequences: string;
  status: AdrStatus;
  supersededById?: string;
  createdAt: Date;
}
