import { describe, expect, test } from "vitest";
import {
  DaemonClient,
  DaemonUnavailableError,
  InvalidDaemonResponseError,
  IpcRuntimeClient,
  RuntimeUnavailableError,
} from "../../apps/cli/src/daemon-client.ts";
import {
  DaemonAlreadyRunningError,
  OfficeDaemon,
  PersistentRuntimeHost,
  RuntimeHostAlreadyRunningError,
} from "../../apps/daemon/src/office-daemon.ts";
import {
  cliHelp,
  CliPromptRequiredError,
  executeRuntimeCommand,
  runCli,
  runtimeCommandHelp,
} from "@ai-office/runtime-host/runtime-command.ts";
import { runDaemonCli, runRuntimeCli } from "../../apps/cli/src/daemon-cli.ts";
import { daemonProtocolVersion } from "@ai-office/application/protocol/daemon-protocol.ts";

/**
 * What "compatibility export" means here, stated once and asserted.
 *
 * Guaranteed: the legacy name resolves, and it is the same binding as its
 * Runtime-first name, so `instanceof` and identity checks behave identically
 * through either name and no parallel error hierarchy exists.
 *
 * Not guaranteed, on purpose: `error.name`, `constructor.name`, and message
 * text now use Runtime terminology.
 */
describe("deprecated pre-Runtime exports", () => {
  test("legacy names are identity aliases, not subclasses", () => {
    expect(DaemonClient).toBe(IpcRuntimeClient);
    expect(DaemonUnavailableError).toBe(RuntimeUnavailableError);
    expect(OfficeDaemon).toBe(PersistentRuntimeHost);
    expect(DaemonAlreadyRunningError).toBe(RuntimeHostAlreadyRunningError);
    expect(runCli).toBe(executeRuntimeCommand);
    expect(cliHelp).toBe(runtimeCommandHelp);
    expect(runDaemonCli).toBe(runRuntimeCli);
  });

  test("instanceof holds through either name, in both directions", () => {
    const client = new IpcRuntimeClient("/tmp/ai-office-compat.sock");
    expect(client).toBeInstanceOf(DaemonClient);
    expect(new DaemonClient("/tmp/ai-office-compat.sock")).toBeInstanceOf(
      IpcRuntimeClient,
    );

    const unavailable = new RuntimeUnavailableError("/tmp/socket");
    expect(unavailable).toBeInstanceOf(DaemonUnavailableError);
    expect(new DaemonUnavailableError("/tmp/socket")).toBeInstanceOf(
      RuntimeUnavailableError,
    );
    expect(unavailable).toBeInstanceOf(Error);
    expect(unavailable).not.toBeInstanceOf(InvalidDaemonResponseError);

    const running = new RuntimeHostAlreadyRunningError("/tmp/socket");
    expect(running).toBeInstanceOf(DaemonAlreadyRunningError);
    expect(new DaemonAlreadyRunningError("/tmp/socket")).toBeInstanceOf(
      RuntimeHostAlreadyRunningError,
    );
  });

  test("error identity is not split into two hierarchies", () => {
    // A wrapper or subclass would let one of these two checks fail depending on
    // which name constructed the value, which is exactly what callers catching
    // the legacy name would hit in production.
    const errors = [
      new DaemonUnavailableError("/tmp/socket"),
      new RuntimeUnavailableError("/tmp/socket"),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(DaemonUnavailableError);
      expect(error).toBeInstanceOf(RuntimeUnavailableError);
    }
  });

  test("names and messages are Runtime-first and are not part of the contract", () => {
    const error = new DaemonUnavailableError("/tmp/socket");
    expect(error.name).toBe("RuntimeUnavailableError");
    expect(error.message).toContain("AI Office Runtime is not available");
    expect(new DaemonAlreadyRunningError("/tmp/socket").name).toBe(
      "RuntimeHostAlreadyRunningError",
    );
    expect(new CliPromptRequiredError("continue?").name).toBe(
      "CliPromptRequiredError",
    );
  });

  test("the daemon protocol version is unchanged", () => {
    expect(daemonProtocolVersion).toBe(1);
  });
});
