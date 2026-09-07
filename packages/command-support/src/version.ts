import manifest from "../../../package.json";

/** Product version; protocol, schema, and profile versions remain independent. */
export const productVersion = manifest.version;

/** Only standalone flags are local; role commands also accept --version. */
export function isLocalVersionInvocation(args: readonly string[]): boolean {
  return args.length === 1 && (args[0] === "--version" || args[0] === "-V");
}
