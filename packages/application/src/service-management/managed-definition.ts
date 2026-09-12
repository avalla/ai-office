import type {
  OfficeServiceDefinitionState,
  OfficeServiceName,
} from "../ports/office-service-manager.port.ts";

/**
 * The deterministic ownership marker written into every generated definition.
 *
 * Its only job is to answer one question: may AI Office replace or delete this
 * file? A path that exists without exactly this evidence belongs to somebody
 * else and is never touched.
 */
export const officeServiceOwnershipMarker = "Managed by AI Office";

/** Bumped only when the generated definition layout itself changes meaning. */
export const officeServiceDefinitionVersion = "ai-office/service/v1";

/**
 * The second half of the ownership evidence: *which* service this file is.
 *
 * Ownership alone is not enough. A runtime definition sitting at the dashboard
 * path is not a file AI Office may silently replace with a dashboard unit; it
 * is evidence that something is wrong, and it fails closed like any other
 * collision.
 */
export function officeServiceDefinitionIdentity(
  service: OfficeServiceName,
): string {
  return `Definition: ${officeServiceDefinitionVersion} ${service}`;
}

/**
 * How far into a file the ownership evidence must appear.
 *
 * Ownership is a property of the file's header, not of a phrase occurring
 * anywhere in it: a marker quoted inside somebody else's `Description=` or
 * inside a plist string is not a claim of ownership.
 */
const ownershipHeaderLineCount = 8;

function headerLines(content: string): string[] {
  return content
    .split("\n", ownershipHeaderLineCount)
    .map((line) => line.trimEnd());
}

/**
 * True only when every required ownership line is present, verbatim, as a
 * whole line of the file's header.
 *
 * Whole-line matching is the point. A substring test accepts
 * `# Not Managed by AI Office`, which asserts the opposite of what it would be
 * read as.
 */
export function hasOfficeServiceOwnership(
  content: string,
  requiredLines: readonly string[],
): boolean {
  const header = headerLines(content);
  return requiredLines.every((required) => header.includes(required));
}

/**
 * Classifies what is currently at a definition path against what AI Office
 * would write there.
 *
 * Pure text comparison on purpose: ownership is a property of the file
 * contents, not of a separate registry that could drift from the filesystem.
 * `requiredLines` are the platform's rendered ownership header lines — the
 * comment syntax differs between a unit file and a plist, the evidence does
 * not.
 */
export function classifyManagedDefinition(
  existing: string | null,
  desired: string,
  requiredLines: readonly string[],
): OfficeServiceDefinitionState {
  if (requiredLines.length === 0)
    throw new Error(
      "Ownership classification requires the expected ownership header lines",
    );
  if (!hasOfficeServiceOwnership(desired, requiredLines))
    // A renderer that stopped emitting its own ownership header would make
    // every later run read its own files as foreign. Fail loudly here rather
    // than quietly refusing to manage anything.
    throw new Error(
      "The rendered service definition does not carry its own ownership header",
    );
  if (existing === null) return "missing";
  if (!hasOfficeServiceOwnership(existing, requiredLines))
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
