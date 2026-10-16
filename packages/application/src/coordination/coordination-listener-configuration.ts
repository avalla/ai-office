/**
 * Owner configuration of the read-only coordination listener (CB-10,
 * ADR-0036 Decision 5 points 1 and 5).
 *
 * The listener is disabled by default. It serves only the projects listed
 * here, each with the data classes the owner enabled for it. The parser is
 * closed: an unknown field, a duplicate project or an invalid class makes the
 * whole configuration misconfigured, and a misconfigured listener does not
 * start (it never falls back to a broader set).
 */

import type { PlanningDataClass } from "./planning-snapshot.ts";

export const coordinationListenerConfigurationVersion = 1 as const;

export type CoordinationListenerConfiguration =
  | { state: "disabled" }
  | {
      state: "enabled";
      /** Project id to the classes enabled for it; P is always present. */
      projects: ReadonlyMap<string, readonly PlanningDataClass[]>;
    }
  | { state: "misconfigured"; reason: string };

const projectIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closed(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  return unknown === undefined ? null : unknown;
}

/**
 * Parses the configuration file text. `undefined` (no file) is disabled.
 * Reasons name the offending field, never a value.
 */
export function parseCoordinationListenerConfiguration(
  text: string | undefined,
): CoordinationListenerConfiguration {
  if (text === undefined) return { state: "disabled" };
  const misconfigured = (reason: string): CoordinationListenerConfiguration => ({
    state: "misconfigured",
    reason,
  });
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return misconfigured("the file is not valid JSON");
  }
  if (!isRecord(value)) return misconfigured("the file must hold one object");
  const unknownTop = closed(value, ["version", "enabled", "projects"]);
  if (unknownTop !== null) return misconfigured(`unknown field ${unknownTop}`);
  if (value.version !== coordinationListenerConfigurationVersion)
    return misconfigured(
      `version must be ${coordinationListenerConfigurationVersion}`,
    );
  if (typeof value.enabled !== "boolean")
    return misconfigured("enabled must be true or false");
  if (!Array.isArray(value.projects))
    return misconfigured("projects must be an array");

  const projects = new Map<string, readonly PlanningDataClass[]>();
  for (const [index, entry] of value.projects.entries()) {
    const where = `projects[${index}]`;
    if (!isRecord(entry)) return misconfigured(`${where} must be an object`);
    const unknownField = closed(entry, ["projectId", "classes"]);
    if (unknownField !== null)
      return misconfigured(`unknown field ${where}.${unknownField}`);
    if (
      typeof entry.projectId !== "string" ||
      !projectIdPattern.test(entry.projectId)
    )
      return misconfigured(`${where}.projectId must be a project identifier`);
    if (projects.has(entry.projectId))
      return misconfigured(`${where}.projectId is listed twice`);
    const classes = entry.classes;
    if (
      !Array.isArray(classes) ||
      new Set(classes).size !== classes.length ||
      !classes.includes("P") ||
      classes.some((item) => item !== "P" && item !== "T")
    )
      return misconfigured(`${where}.classes must be ["P"] or ["P", "T"]`);
    projects.set(
      entry.projectId,
      (classes as PlanningDataClass[]).slice().sort(),
    );
  }
  if (!value.enabled) return { state: "disabled" };
  if (projects.size === 0)
    return misconfigured("an enabled listener must list at least one project");
  return { state: "enabled", projects };
}
