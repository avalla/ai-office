import type { OfficeServiceDefinitionState } from "../ports/office-service-manager.port.ts";

/**
 * The deterministic ownership marker written into every generated definition.
 *
 * Its only job is to answer one question: may AI Office replace or delete this
 * file? A path that exists without the marker belongs to somebody else and is
 * never touched.
 */
export const officeServiceOwnershipMarker = "Managed by AI Office";

/**
 * Classifies what is currently at a definition path against what AI Office
 * would write there.
 *
 * Pure text comparison on purpose: ownership is a property of the file
 * contents, not of a separate registry that could drift from the filesystem.
 */
export function classifyManagedDefinition(
  existing: string | null,
  desired: string,
): OfficeServiceDefinitionState {
  if (existing === null) return "missing";
  if (!existing.includes(officeServiceOwnershipMarker))
    return "unmanaged_collision";
  return existing === desired ? "managed_current" : "managed_outdated";
}

/**
 * Rejects values that cannot be represented in a single-line unit directive.
 *
 * A newline in a rendered path would silently split a directive and produce a
 * file that means something other than what was planned, so rendering fails
 * closed rather than emitting it.
 */
export function assertRenderableValue(value: string, label: string): string {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || codePoint === 0x7f)
      throw new Error(
        `${label} contains a control character and cannot be written to a service definition`,
      );
  }
  return value;
}
