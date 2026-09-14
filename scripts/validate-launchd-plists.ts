/**
 * Validates the generated LaunchAgent plists with macOS's own parser.
 *
 * Every other launchd test answers `launchctl` from a fake, which proves the
 * adapter's logic but says nothing about whether Apple's property-list parser
 * accepts the bytes AI Office writes. `plutil -lint` settles that, and it is
 * the only part of launchd support that genuinely requires a macOS host.
 *
 * Nothing is installed and nothing is bootstrapped: the plists are rendered
 * into a temporary directory, linted, and discarded. The user's real
 * `~/Library/LaunchAgents` is never touched.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { officeServiceNames } from "@ai-office/application/ports/office-service-manager.port.ts";
import {
  launchdLabels,
  renderLaunchdPlist,
} from "@ai-office/service-management/launchd-user-service-manager.ts";
import type { OfficeServicePlan } from "@ai-office/service-management/service-plan.ts";

if (process.platform !== "darwin") {
  console.log(
    "Skipping plutil validation: it only proves anything on a macOS host.",
  );
  process.exit(0);
}

/**
 * A plan whose paths exercise the characters that break naive rendering: XML
 * metacharacters, a percent, a dollar sign, and a space.
 */
const plan: OfficeServicePlan = {
  program: {
    launcher: [
      "/opt/bun & co/bin/bun",
      "/opt/ai-office <100%>/bin/ai$office.ts",
    ],
    runtimeHome: '/Users/operator/Library/Application Support/ai"office',
    requiresSourceRuntimeOptIn: true,
  },
  dashboard: { host: "127.0.0.1", port: 4278, awaitRuntimeSeconds: 60 },
};

const directory = mkdtempSync(join(tmpdir(), "ai-office-plutil-"));
let failures = 0;
try {
  for (const service of officeServiceNames) {
    const path = join(directory, `${launchdLabels[service]}.plist`);
    writeFileSync(path, renderLaunchdPlist(plan, service), "utf8");
    const linted = Bun.spawnSync(["plutil", "-lint", path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output =
      `${linted.stdout.toString()}${linted.stderr.toString()}`.trim();
    if (linted.exitCode === 0) {
      console.log(`plutil -lint ${launchdLabels[service]}.plist: OK`);
      continue;
    }
    failures += 1;
    console.error(
      `plutil -lint rejected the ${service} plist (exit ${linted.exitCode}): ${output}`,
    );
  }

  // A lint pass only proves the document parses. Read it back through Apple's
  // parser too, so a plist that is well-formed but says the wrong thing fails
  // here rather than at boot on an operator's machine.
  for (const service of officeServiceNames) {
    const path = join(directory, `${launchdLabels[service]}.plist`);
    const converted = Bun.spawnSync(
      ["plutil", "-convert", "json", "-o", "-", path],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (converted.exitCode !== 0) {
      failures += 1;
      console.error(
        `plutil could not read the ${service} plist: ${converted.stderr.toString().trim()}`,
      );
      continue;
    }
    const parsed = JSON.parse(converted.stdout.toString()) as {
      Label?: unknown;
      ProgramArguments?: unknown;
      EnvironmentVariables?: Record<string, unknown>;
    };
    const expectedLauncher = plan.program.launcher;
    const actual = Array.isArray(parsed.ProgramArguments)
      ? parsed.ProgramArguments.slice(0, expectedLauncher.length)
      : [];
    const mismatches: string[] = [];
    if (parsed.Label !== launchdLabels[service])
      mismatches.push(`Label is ${String(parsed.Label)}`);
    if (JSON.stringify(actual) !== JSON.stringify(expectedLauncher))
      mismatches.push(`ProgramArguments begin ${JSON.stringify(actual)}`);
    if (
      parsed.EnvironmentVariables?.AI_OFFICE_HOME !== plan.program.runtimeHome
    )
      mismatches.push(
        `AI_OFFICE_HOME is ${String(parsed.EnvironmentVariables?.AI_OFFICE_HOME)}`,
      );
    // Only the Runtime reads model routing, and only from its Runtime home.
    const routingSource =
      parsed.EnvironmentVariables?.AI_OFFICE_MODEL_ROUTING_SOURCE;
    if (routingSource !== (service === "runtime" ? "runtime_home" : undefined))
      mismatches.push(
        `AI_OFFICE_MODEL_ROUTING_SOURCE is ${String(routingSource)}`,
      );
    if (mismatches.length > 0) {
      failures += 1;
      console.error(
        `The ${service} plist does not round-trip through plutil: ${mismatches.join("; ")}`,
      );
      continue;
    }
    console.log(`plutil round-trip ${launchdLabels[service]}.plist: OK`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

if (failures > 0) process.exit(1);
console.log("The generated LaunchAgent plists are valid on this macOS host.");
