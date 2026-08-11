import { createRequire } from "node:module";
import { resolve } from "node:path";

interface NativeProbeResult {
  platform: string;
  architecture: string;
  supported: boolean;
  openat2: boolean;
  requiredResolveFlags: boolean;
  renameat2: boolean;
  renameNoreplace: boolean;
  statx: boolean;
  mountIdentity: string;
  directoryFsync: boolean;
  unlinkat: boolean;
  closeOnExec: boolean;
  noFollow: boolean;
  exclusiveCreate: boolean;
  failures: string[];
}

const modulePath = process.argv[2];
if (modulePath === undefined) {
  throw new Error("native module path is required");
}

const require = createRequire(import.meta.url);
const native = require(resolve(modulePath)) as {
  probeCapabilities(): NativeProbeResult;
};
const result = native.probeCapabilities();

if (typeof result !== "object" || result === null) {
  throw new Error("native probe returned an invalid result");
}

console.log(JSON.stringify(result, null, 2));
if (!result.supported) process.exitCode = 2;
