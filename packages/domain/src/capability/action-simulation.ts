import { normalizeCanonicalJson } from "./canonical-json.ts";
import { CapabilityValidationError } from "./errors.ts";

export type FilePrecondition =
  | { readonly kind: "absent"; readonly path: string }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly sha256: string;
      readonly size: number;
    };

export interface ActionSimulationProps {
  id: string;
  projectId: string;
  actionRequestId: string;
  authorizationPayloadHash: string;
  connector: string;
  connectorVersion: string;
  operation: string;
  preconditions: readonly FilePrecondition[];
  diff: string;
  diffSha256: string;
  artifactSha256: string;
  createdAt: Date;
}

function validHash(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

export function normalizeFilePreconditions(
  value: unknown,
): readonly FilePrecondition[] {
  const normalized = normalizeCanonicalJson(value);
  if (!Array.isArray(normalized))
    throw new CapabilityValidationError(
      "Action simulation preconditions must be an array",
    );
  const result: FilePrecondition[] = [];
  const identities = new Set<string>();
  for (const candidate of normalized) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    )
      throw new CapabilityValidationError(
        "Action simulation precondition is invalid",
      );
    const record = candidate as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort();
    if (
      typeof record.path !== "string" ||
      record.path.length === 0 ||
      (record.kind !== "absent" && record.kind !== "file")
    )
      throw new CapabilityValidationError(
        "Action simulation precondition is invalid",
      );
    if (record.kind === "absent") {
      if (keys.join(",") !== "kind,path")
        throw new CapabilityValidationError(
          "Action simulation absent precondition is invalid",
        );
      result.push(Object.freeze({ kind: "absent", path: record.path }));
    } else {
      if (
        keys.join(",") !== "kind,path,sha256,size" ||
        typeof record.sha256 !== "string" ||
        !validHash(record.sha256) ||
        typeof record.size !== "number" ||
        !Number.isSafeInteger(record.size) ||
        record.size < 0
      )
        throw new CapabilityValidationError(
          "Action simulation file precondition is invalid",
        );
      result.push(
        Object.freeze({
          kind: "file",
          path: record.path,
          sha256: record.sha256,
          size: record.size,
        }),
      );
    }
    const identity = record.path;
    if (identities.has(identity))
      throw new CapabilityValidationError(
        "Action simulation preconditions contradict for the same path",
      );
    identities.add(identity);
  }
  return Object.freeze(result);
}

export class ActionSimulation {
  private constructor(private readonly props: ActionSimulationProps) {}

  static create(props: ActionSimulationProps): ActionSimulation {
    for (const value of [
      props.id,
      props.projectId,
      props.actionRequestId,
      props.connector,
      props.connectorVersion,
      props.operation,
    ]) {
      if (value.trim().length === 0)
        throw new CapabilityValidationError(
          "Action simulation identifiers cannot be empty",
        );
    }
    for (const hash of [
      props.authorizationPayloadHash,
      props.diffSha256,
      props.artifactSha256,
    ]) {
      if (!validHash(hash))
        throw new CapabilityValidationError(
          "Action simulation hash is invalid",
        );
    }
    if (!Number.isFinite(props.createdAt.getTime()))
      throw new CapabilityValidationError(
        "Action simulation timestamp is invalid",
      );
    const preconditions = normalizeFilePreconditions(props.preconditions);
    return new ActionSimulation({
      ...props,
      preconditions,
      createdAt: new Date(props.createdAt),
    });
  }

  snapshot(): ActionSimulationProps {
    return {
      ...this.props,
      preconditions: [...this.props.preconditions],
      createdAt: new Date(this.props.createdAt),
    };
  }
}
