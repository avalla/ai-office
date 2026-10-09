/**
 * Shared task-delivery setup schema (M19-T4): the one vocabulary of setup
 * keys, their accepted values, and the built-in defaults. The Runtime
 * services validate writes against this table, the `.task-delivery.yaml`
 * schema and the skill documentation mirror it, and the skill validation
 * compares all three so a key cannot drift apart between them.
 */

export const checkpointFrequencies = [
  "every-gate",
  "stage-boundaries",
  "handoff-only",
] as const;
export type CheckpointFrequency = (typeof checkpointFrequencies)[number];

export const handoffModes = ["offer", "gate"] as const;
export type HandoffMode = (typeof handoffModes)[number];

export const resumeDetails = ["brief", "standard", "full"] as const;
export type ResumeDetail = (typeof resumeDetails)[number];

export const setupKnowledgePolicies = [
  "auto",
  "required",
  "disabled",
] as const;
export type SetupKnowledgePolicy = (typeof setupKnowledgePolicies)[number];

export interface TaskDeliverySetupKeySpec {
  /** Enumerated string values, when the key is a word. */
  readonly values?: readonly string[];
  /** Inclusive numeric range, when the key is a number. */
  readonly number?: { readonly min: number; readonly max: number };
}

export const taskDeliverySetupSchema = {
  checkpointFrequency: { values: checkpointFrequencies },
  handoffMode: { values: handoffModes },
  resumeDetail: { values: resumeDetails },
  knowledgePolicy: { values: setupKnowledgePolicies },
  contextThreshold: { number: { min: 0, max: 1 } },
} as const satisfies Readonly<Record<string, TaskDeliverySetupKeySpec>>;

export type TaskDeliverySetupKey = keyof typeof taskDeliverySetupSchema;

export const taskDeliverySetupKeys: readonly TaskDeliverySetupKey[] =
  Object.keys(taskDeliverySetupSchema).sort() as TaskDeliverySetupKey[];

export interface TaskDeliverySetupValues {
  readonly checkpointFrequency: CheckpointFrequency;
  readonly handoffMode: HandoffMode;
  readonly resumeDetail: ResumeDetail;
  readonly knowledgePolicy: SetupKnowledgePolicy;
  readonly contextThreshold: number;
}

/** The built-in defaults, lowest precedence in every resolution path. */
export const defaultTaskDeliverySetupValues: TaskDeliverySetupValues =
  Object.freeze({
    checkpointFrequency: "every-gate",
    handoffMode: "offer",
    resumeDetail: "standard",
    knowledgePolicy: "auto",
    contextThreshold: 0.25,
  });

export function isTaskDeliverySetupKey(
  key: string,
): key is TaskDeliverySetupKey {
  return Object.hasOwn(taskDeliverySetupSchema, key);
}

/**
 * One stored or configured value, checked against the key's contract.
 * Returns the typed value, or null when the value is outside the contract.
 */
export function validateTaskDeliverySetupValue(
  key: TaskDeliverySetupKey,
  value: unknown,
): string | number | null {
  const spec = taskDeliverySetupSchema[key];
  if (spec.values !== undefined)
    return typeof value === "string" &&
      (spec.values as readonly string[]).includes(value)
      ? value
      : null;
  if (spec.number !== undefined)
    return typeof value === "number" &&
      Number.isFinite(value) &&
      value >= spec.number.min &&
      value <= spec.number.max
      ? value
      : null;
  return null;
}
