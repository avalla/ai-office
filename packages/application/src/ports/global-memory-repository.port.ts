import type { GlobalLesson } from "@ai-office/domain/memory/global-lesson.ts";
import type { GlobalPattern } from "@ai-office/domain/memory/global-pattern.ts";
import type { GlobalRole } from "@ai-office/domain/memory/global-role.ts";
import type { MemoryTargetType } from "@ai-office/domain/memory/memory-reference.ts";

export interface MemorySearchResult {
  readonly type: MemoryTargetType;
  readonly id: string;
  readonly version?: number;
  readonly name: string;
  readonly summary: string;
  readonly status: "active" | "deprecated";
  readonly score: number;
}

export interface GlobalMemoryRepository {
  saveRole(role: GlobalRole): Promise<void>;
  updateRoleStatus(role: GlobalRole): Promise<void>;
  findRole(id: string, version: number): Promise<GlobalRole | null>;
  findLatestRole(id: string): Promise<GlobalRole | null>;
  findLatestRoleByKey(key: string): Promise<GlobalRole | null>;
  savePattern(pattern: GlobalPattern): Promise<void>;
  findPattern(id: string, version: number): Promise<GlobalPattern | null>;
  saveLesson(lesson: GlobalLesson): Promise<void>;
  findLesson(id: string): Promise<GlobalLesson | null>;
  search(query: string, limit: number): Promise<readonly MemorySearchResult[]>;
}
