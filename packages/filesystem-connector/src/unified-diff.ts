import {
  FilesystemDiffTooLargeError,
  FilesystemOperationAbortedError,
} from "./errors.ts";

interface SplitText {
  lines: readonly string[];
  finalNewline: boolean;
}

function splitText(value: string): SplitText {
  const normalized = value.replaceAll("\r\n", "\n");
  const finalNewline = normalized.endsWith("\n");
  const body = finalNewline ? normalized.slice(0, -1) : normalized;
  return {
    lines: body.length === 0 ? [] : body.split("\n"),
    finalNewline,
  };
}

function range(count: number): string {
  return count === 1 ? "1" : `1,${count}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new FilesystemOperationAbortedError();
}

export function createUnifiedDiff(input: {
  oldPath: string | null;
  newPath: string | null;
  oldContent: string;
  newContent: string;
  maxBytes: number;
  signal?: AbortSignal;
}): string {
  throwIfAborted(input.signal);
  if (input.oldPath === input.newPath && input.oldContent === input.newContent)
    return "";
  const oldText = splitText(input.oldContent);
  const newText = splitText(input.newContent);
  const lines = [
    `--- ${input.oldPath === null ? "/dev/null" : `a/${input.oldPath}`}`,
    `+++ ${input.newPath === null ? "/dev/null" : `b/${input.newPath}`}`,
    `@@ -${range(oldText.lines.length)} +${range(newText.lines.length)} @@`,
  ];
  for (const line of oldText.lines) {
    throwIfAborted(input.signal);
    lines.push(`-${line}`);
  }
  if (!oldText.finalNewline && oldText.lines.length > 0)
    lines.push("\\ No newline at end of file");
  for (const line of newText.lines) {
    throwIfAborted(input.signal);
    lines.push(`+${line}`);
  }
  if (!newText.finalNewline && newText.lines.length > 0)
    lines.push("\\ No newline at end of file");
  const diff = `${lines.join("\n")}\n`;
  if (new TextEncoder().encode(diff).byteLength > input.maxBytes)
    throw new FilesystemDiffTooLargeError();
  return diff;
}

export function combineUnifiedDiffs(
  diffs: readonly string[],
  maxBytes: number,
  signal?: AbortSignal,
): string {
  throwIfAborted(signal);
  const combined = diffs.filter((diff) => diff.length > 0).join("");
  if (new TextEncoder().encode(combined).byteLength > maxBytes)
    throw new FilesystemDiffTooLargeError();
  return combined;
}
