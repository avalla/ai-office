import type { OfficeManifestRevision } from "@ai-office/domain/office/office-manifest.ts";

export interface OfficeManifestRepository {
  findLatest(projectId: string): Promise<OfficeManifestRevision | null>;
  save(revision: OfficeManifestRevision): Promise<void>;
}
