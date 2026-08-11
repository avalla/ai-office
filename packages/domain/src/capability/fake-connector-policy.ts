import type {
  ConnectorConstraintHandler,
  ConnectorConstraintResult,
  FakeConnectorConstraints,
} from "./capability.ts";
import { canonicalStringify } from "./canonical-json.ts";
import { InvalidCapabilityConstraintsError } from "./errors.ts";

const fields = new Set([
  "allowedTargets",
  "deniedTargets",
  "maxPayloadBytes",
  "allowMutation",
]);

function parseStringList(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  )
    return null;
  return [...new Set(value)].sort();
}

function parseConstraint(value: Readonly<Record<string, unknown>>): {
  value?: FakeConnectorConstraints;
  error?: string;
} {
  const unknown = Object.keys(value).filter((key) => !fields.has(key));
  if (unknown.length > 0)
    return {
      error: `unsupported fake constraint fields: ${unknown.sort().join(", ")}`,
    };
  const allowed =
    value.allowedTargets === undefined
      ? undefined
      : parseStringList(value.allowedTargets);
  const denied =
    value.deniedTargets === undefined
      ? undefined
      : parseStringList(value.deniedTargets);
  if (allowed === null || denied === null)
    return { error: "target constraints must be arrays of non-empty strings" };
  const maxPayloadBytes = value.maxPayloadBytes;
  if (
    maxPayloadBytes !== undefined &&
    (typeof maxPayloadBytes !== "number" ||
      !Number.isSafeInteger(maxPayloadBytes) ||
      maxPayloadBytes < 0)
  )
    return { error: "maxPayloadBytes must be a non-negative safe integer" };
  if (
    value.allowMutation !== undefined &&
    typeof value.allowMutation !== "boolean"
  )
    return { error: "allowMutation must be boolean" };
  return {
    value: {
      ...(allowed === undefined ? {} : { allowedTargets: allowed }),
      ...(denied === undefined ? {} : { deniedTargets: denied }),
      ...(maxPayloadBytes === undefined ? {} : { maxPayloadBytes }),
      ...(value.allowMutation === undefined
        ? {}
        : { allowMutation: value.allowMutation }),
    },
  };
}

export function validateFakeConnectorConstraints(
  value: Readonly<Record<string, unknown>>,
): FakeConnectorConstraints {
  const result = parseConstraint(value);
  if (result.value === undefined)
    throw new InvalidCapabilityConstraintsError(
      result.error ?? "Invalid fake connector constraints",
    );
  return result.value;
}

export class FakeConnectorConstraintHandler implements ConnectorConstraintHandler {
  readonly connector = "fake";

  readonly combineAndValidate: ConnectorConstraintHandler["combineAndValidate"] =
    (
      operation: string,
      arguments_: Readonly<Record<string, unknown>>,
      values: readonly Readonly<Record<string, unknown>>[],
      _resourceConfiguration: Readonly<Record<string, unknown>>,
    ): ConnectorConstraintResult => {
      const parsed: FakeConnectorConstraints[] = [];
      for (const value of values) {
        const result = parseConstraint(value);
        if (result.value === undefined)
          return {
            ok: false,
            effectiveConstraints: {},
            reasons: [result.error ?? "unsafe constraints"],
          };
        parsed.push(result.value);
      }

      const allowedLists = parsed
        .map((value) => value.allowedTargets)
        .filter((value): value is readonly string[] => value !== undefined);
      let allowedTargets: readonly string[] | undefined;
      if (allowedLists.length > 0) {
        const intersection = allowedLists
          .slice(1)
          .reduce(
            (intersection, list) =>
              intersection.filter((target) => list.includes(target)),
            [...allowedLists[0]!],
          );
        allowedTargets = [...intersection].sort();
      }
      const deniedTargets = [
        ...new Set(parsed.flatMap((value) => value.deniedTargets ?? [])),
      ].sort();
      const maxima = parsed
        .map((value) => value.maxPayloadBytes)
        .filter((value): value is number => value !== undefined);
      const maxPayloadBytes =
        maxima.length === 0 ? undefined : Math.min(...maxima);
      const allowMutation = parsed.every(
        (value) => value.allowMutation === true,
      );
      const effective: Readonly<Record<string, unknown>> = {
        ...(allowedTargets === undefined ? {} : { allowedTargets }),
        deniedTargets,
        ...(maxPayloadBytes === undefined ? {} : { maxPayloadBytes }),
        allowMutation,
      };

      const reasons: string[] = [];
      const target = arguments_.target;
      if (
        (allowedTargets !== undefined || deniedTargets.length > 0) &&
        typeof target !== "string"
      )
        reasons.push("fake constraints require a string target argument");
      if (typeof target === "string") {
        if (allowedTargets !== undefined && !allowedTargets.includes(target))
          reasons.push(`target ${target} is not allowed`);
        if (deniedTargets.includes(target))
          reasons.push(`target ${target} is denied`);
      }
      if (operation !== "fake.read" && !allowMutation)
        reasons.push("mutation is not allowed by the effective constraints");
      if (maxPayloadBytes !== undefined) {
        const bytes = new TextEncoder().encode(
          canonicalStringify(arguments_),
        ).byteLength;
        if (bytes > maxPayloadBytes)
          reasons.push(
            `canonical arguments exceed maxPayloadBytes (${bytes} > ${maxPayloadBytes})`,
          );
      }
      return {
        ok: reasons.length === 0,
        effectiveConstraints: effective,
        reasons,
      };
    };
}
