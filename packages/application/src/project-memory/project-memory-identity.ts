import { createHash } from "node:crypto";
import type { ProjectMemoryIdentity } from "../ports/project-memory-provider.port.ts";

/**
 * Domain separator for the derivation. Changing it would silently move every
 * repository to a new, empty memory namespace, so it is versioned explicitly.
 */
const derivationContext = "ai-office-project-memory-identity-v1";

/** `aio-` followed by 32 lowercase hexadecimal characters (128 bits). */
export const projectMemoryIdentityPattern = /^aio-[0-9a-f]{32}$/;

/**
 * Derives the durable project-memory identity from AI Office's portable
 * repository ID (the `repositoryId` in `.ai-office/project.json`).
 *
 * `aio-` + first 32 hex characters of
 * `SHA-256("ai-office-project-memory-identity-v1" || 0x00 || repositoryId)`.
 *
 * Only the portable repository ID participates. The runtime-local project ID,
 * the caller's working directory, checkout and worktree paths, the runtime home
 * and the host name are deliberately absent, so every checkout and worktree of
 * one logical repository, on any machine, reaches the same memory and nothing
 * local or secret is disclosed to the provider.
 */
export function deriveProjectMemoryIdentity(
  repositoryId: string,
): ProjectMemoryIdentity {
  if (repositoryId.trim() === "" || repositoryId.length > 256)
    throw new TypeError("A portable repository ID is required");
  const digest = createHash("sha256")
    .update(`${derivationContext}\0${repositoryId}`, "utf8")
    .digest("hex");
  return Object.freeze({ memoryProjectId: `aio-${digest.slice(0, 32)}` });
}
