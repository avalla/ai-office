import type { ConnectorFilePrecondition } from "@ai-office/connector-sdk/connector.ts";

export interface AtomicMutationPlan {
  operation: "create" | "write" | "move" | "delete";
  sourcePath?: string;
  destinationPath?: string;
  content?: string;
  preconditions: readonly ConnectorFilePrecondition[];
  strategy:
    | "exclusive-sibling-temp-then-rename"
    | "same-filesystem-rename"
    | "tombstone-then-unlink";
}

export function planAtomicMutation(input: {
  operation: AtomicMutationPlan["operation"];
  sourcePath?: string;
  destinationPath?: string;
  content?: string;
  preconditions: readonly ConnectorFilePrecondition[];
}): AtomicMutationPlan {
  const strategy =
    input.operation === "move"
      ? "same-filesystem-rename"
      : input.operation === "delete"
        ? "tombstone-then-unlink"
        : "exclusive-sibling-temp-then-rename";
  return Object.freeze({
    ...input,
    preconditions: Object.freeze([...input.preconditions]),
    strategy,
  });
}
