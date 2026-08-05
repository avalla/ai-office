import type { LoadedAgentDefinition } from "@ai-office/agent-runtime/yaml-agent-definition-loader.ts";
import type { Agent } from "@ai-office/domain/agent/agent.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { ProjectNotFoundError } from "../errors.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";

export class SyncAgentDefinitions {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly runtime: AgentRuntimeRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}
  async execute(
    projectId: string,
    loaded: LoadedAgentDefinition[],
  ): Promise<number> {
    if ((await this.projects.findById(projectId)) === null)
      throw new ProjectNotFoundError(projectId);
    const now = this.clock.now();
    await this.transactions.run(async () => {
      for (const item of loaded) {
        const roleId = `role:${projectId}:${item.definition.id}`;
        await this.runtime.saveRole(
          Role.create({
            id: roleId,
            projectId,
            key: item.definition.id,
            name: item.definition.role,
            version: item.definition.version,
            capabilities: item.definition.capabilities,
            tools: item.definition.tools,
            modelPolicy: item.definition.modelPolicy,
            limits: item.definition.limits,
            sourcePath: item.sourcePath,
            now,
          }),
        );
        const agent: Agent = {
          id: `agent:${projectId}:${item.definition.id}`,
          projectId,
          roleId,
          name: item.definition.id,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        };
        await this.runtime.saveAgent(agent);
      }
    });
    return loaded.length;
  }
}
