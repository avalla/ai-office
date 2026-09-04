export interface RuntimeHostStartInvocation {
  kind: "start";
  compatibilityAlias: boolean;
  unexpectedArguments: string[];
}

export function parseRuntimeHostStart(
  args: string[],
): RuntimeHostStartInvocation | null {
  if (args[0] === "daemon") {
    return {
      kind: "start",
      compatibilityAlias: true,
      unexpectedArguments: args.slice(1),
    };
  }
  if (args[0] === "runtime" && args[1] === "start") {
    return {
      kind: "start",
      compatibilityAlias: false,
      unexpectedArguments: args.slice(2),
    };
  }
  return null;
}
