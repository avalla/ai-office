import { DomainValidationError } from "../errors.ts";

/** Identifies the selected implementation, not proof that a task was delivered. */
export interface AgentExecutionProvenance {
  kind: "simulation" | "controlled_action" | "worker";
  adapterId: string;
  adapterVersion: string;
  inputHash?: string;
}

export function parseAgentExecution(value: unknown): AgentExecutionProvenance {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new DomainValidationError("Invalid execution provenance");
  const record = value as Record<string, unknown>;
  if (
    typeof record.kind !== "string" ||
    !["simulation", "controlled_action", "worker"].includes(record.kind) ||
    typeof record.adapterId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(record.adapterId) ||
    typeof record.adapterVersion !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/.test(record.adapterVersion) ||
    (record.inputHash !== undefined &&
      (typeof record.inputHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.inputHash))) ||
    (record.kind === "worker" && record.inputHash === undefined) ||
    Object.keys(record).some(
      (key) =>
        !["kind", "adapterId", "adapterVersion", "inputHash"].includes(key),
    )
  )
    throw new DomainValidationError("Invalid execution provenance");
  return Object.freeze({
    kind: record.kind as AgentExecutionProvenance["kind"],
    adapterId: record.adapterId,
    adapterVersion: record.adapterVersion,
    ...(record.inputHash === undefined
      ? {}
      : { inputHash: record.inputHash as string }),
  });
}
