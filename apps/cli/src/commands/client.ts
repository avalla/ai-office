import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ManageAgentClientIntegration } from "@ai-office/application/agent-client/manage-agent-client-integration.ts";
import {
  agentClientIds,
  type AgentClientId,
} from "@ai-office/application/ports/agent-client-adapter.port.ts";
import { parseProjectInstructionContract } from "@ai-office/domain/agent/project-instruction-contract.ts";
import {
  CliUsageError,
  type CommandContext,
  parseArguments,
  requiredOption,
} from "./shared.ts";

const maximumContractBytes = 256 * 1024;

function clientId(value: string): AgentClientId {
  if (!agentClientIds.some((candidate) => candidate === value))
    throw new CliUsageError(
      `Agent client must be one of: ${agentClientIds.join(", ")}`,
    );
  return value as AgentClientId;
}

function contractFromFile(rootInput: string, fileInput: string) {
  let rootPath: string;
  let filePath: string;
  try {
    rootPath = realpathSync(resolve(rootInput));
    filePath = realpathSync(resolve(rootPath, fileInput));
  } catch {
    throw new CliUsageError(
      `Project instruction contract was not found: ${fileInput}`,
    );
  }
  const relativePath = relative(rootPath, filePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    throw new CliUsageError(
      "Project instruction contract must be a file inside the integration root",
    );
  const status = statSync(filePath);
  if (!status.isFile())
    throw new CliUsageError(
      "Project instruction contract must be a regular file",
    );
  if (status.size > maximumContractBytes)
    throw new CliUsageError(
      `Project instruction contract exceeds ${maximumContractBytes} bytes`,
    );
  try {
    return parseProjectInstructionContract(
      JSON.parse(readFileSync(filePath, "utf8")) as unknown,
    );
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new CliUsageError(
        "Project instruction contract must be valid JSON",
      );
    throw error;
  }
}

export async function handleClientCommand(
  command: string,
  args: string[],
  context: CommandContext,
): Promise<number | null> {
  if (!command.startsWith("client:")) return null;
  const service = new ManageAgentClientIntegration(context.agentClients);

  if (command === "client:detect") {
    const parsed = parseArguments(args, new Set(["client"]));
    if (parsed.positionals.length > 0)
      throw new CliUsageError("client:detect only accepts named options");
    const selected = parsed.options.get("client");
    context.io.stdout(
      JSON.stringify(
        await service.detect(
          selected === undefined ? undefined : clientId(selected),
        ),
      ),
    );
    return 0;
  }

  if (
    command !== "client:inspect" &&
    command !== "client:validate" &&
    command !== "client:plan" &&
    command !== "client:apply" &&
    command !== "client:uninstall"
  )
    return null;

  const allowedOptions =
    command === "client:inspect" || command === "client:validate"
      ? new Set(["client", "root"])
      : command === "client:plan"
        ? new Set(["client", "root", "contract"])
        : command === "client:apply"
          ? new Set(["client", "root", "contract", "approve"])
          : new Set(["client", "root", "approve"]);
  const parsed = parseArguments(args, allowedOptions);
  if (parsed.positionals.length > 0)
    throw new CliUsageError(`${command} only accepts named options`);
  const selected = clientId(requiredOption(parsed, "client"));
  const rootPath = requiredOption(parsed, "root");

  if (command === "client:inspect") {
    context.io.stdout(
      JSON.stringify(await service.inspect(selected, rootPath)),
    );
    return 0;
  }
  if (command === "client:validate") {
    const validation = await service.validate(selected, rootPath);
    context.io.stdout(JSON.stringify(validation));
    return validation.valid ? 0 : 1;
  }
  if (command === "client:plan") {
    const contract = contractFromFile(
      rootPath,
      requiredOption(parsed, "contract"),
    );
    context.io.stdout(
      JSON.stringify(
        await service.plan({ clientId: selected, rootPath, contract }),
      ),
    );
    return 0;
  }
  if (command === "client:apply") {
    const contract = contractFromFile(
      rootPath,
      requiredOption(parsed, "contract"),
    );
    const validation = await service.apply({
      clientId: selected,
      rootPath,
      contract,
      approvedPlanHash: requiredOption(parsed, "approve"),
    });
    context.io.stdout(JSON.stringify({ applied: true, validation }));
    return validation.valid ? 0 : 1;
  }
  if (command === "client:uninstall") {
    const approvedPlanHash = parsed.options.get("approve");
    if (approvedPlanHash === undefined) {
      context.io.stdout(
        JSON.stringify(
          await service.planUninstall({ clientId: selected, rootPath }),
        ),
      );
      return 0;
    }
    const inspection = await service.uninstall({
      clientId: selected,
      rootPath,
      approvedPlanHash,
    });
    context.io.stdout(JSON.stringify({ uninstalled: true, inspection }));
    return 0;
  }
  return null;
}
