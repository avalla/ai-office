import type { MemoryReference } from "@ai-office/domain/memory/memory-reference.ts";

export interface MemoryReferenceRepository {
  saveReference(reference: MemoryReference): Promise<string>;
  listReferences(projectId: string): Promise<readonly MemoryReference[]>;
}
