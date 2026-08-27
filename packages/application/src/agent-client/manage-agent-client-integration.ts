import { createHash } from "node:crypto";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import type { ProjectInstructionContract } from "@ai-office/domain/agent/project-instruction-contract.ts";
import type {
  AgentClientCatalog,
  AgentClientDetection,
  AgentClientFileChange,
  AgentClientId,
  AgentClientInspection,
  AgentClientIntegrationDraft,
  AgentClientValidation,
} from "../ports/agent-client-adapter.port.ts";
import { compileProjectInstructions } from "./instruction-compiler.ts";
import { compileProjectSkill } from "./project-skill-compiler.ts";
import {
  AgentClientPlanApprovalError,
  AgentClientPlanConflictError,
} from "./errors.ts";

export interface AgentClientIntegrationPlan {
  contractVersion: 1;
  action: "install" | "uninstall";
  clientId: AgentClientId;
  rootPath: string;
  planHash: string;
  changes: readonly AgentClientFileChange[];
  issues: AgentClientIntegrationDraft["issues"];
}

function hashDraft(draft: AgentClientIntegrationDraft): string {
  return createHash("sha256")
    .update(canonicalStringify(draft), "utf8")
    .digest("hex");
}

function publicPlan(
  draft: AgentClientIntegrationDraft,
): AgentClientIntegrationPlan {
  return {
    contractVersion: 1,
    action: draft.action,
    clientId: draft.clientId,
    rootPath: draft.rootPath,
    planHash: hashDraft(draft),
    changes: draft.operations.map((operation) => ({
      kind: operation.kind,
      relativePath: operation.relativePath,
      expectedSha256: operation.expectedSha256,
      ownershipAfter: operation.ownershipAfter,
      summary: operation.summary,
    })),
    issues: draft.issues,
  };
}

export class ManageAgentClientIntegration {
  constructor(private readonly clients: AgentClientCatalog) {}

  async detect(clientId?: AgentClientId): Promise<AgentClientDetection[]> {
    const clients =
      clientId === undefined
        ? this.clients.list()
        : [this.clients.get(clientId)];
    return Promise.all(clients.map((client) => client.detect()));
  }

  inspect(
    clientId: AgentClientId,
    rootPath: string,
  ): Promise<AgentClientInspection> {
    return this.clients.get(clientId).inspect(rootPath);
  }

  async plan(input: {
    clientId: AgentClientId;
    rootPath: string;
    contract: ProjectInstructionContract;
  }): Promise<AgentClientIntegrationPlan> {
    const draft = await this.clients.get(input.clientId).plan({
      rootPath: input.rootPath,
      canonicalInstructions: compileProjectInstructions(input.contract),
      projectSkill: compileProjectSkill(),
    });
    return publicPlan(draft);
  }

  async apply(input: {
    clientId: AgentClientId;
    rootPath: string;
    contract: ProjectInstructionContract;
    approvedPlanHash: string;
  }): Promise<AgentClientValidation> {
    const client = this.clients.get(input.clientId);
    const draft = await client.plan({
      rootPath: input.rootPath,
      canonicalInstructions: compileProjectInstructions(input.contract),
      projectSkill: compileProjectSkill(),
    });
    if (draft.issues.some((issue) => issue.severity === "conflict"))
      throw new AgentClientPlanConflictError();
    if (hashDraft(draft) !== input.approvedPlanHash)
      throw new AgentClientPlanApprovalError();
    await client.apply(draft);
    return client.validate(input.rootPath);
  }

  async planUninstall(input: {
    clientId: AgentClientId;
    rootPath: string;
  }): Promise<AgentClientIntegrationPlan> {
    return publicPlan(
      await this.clients.get(input.clientId).planUninstall(input.rootPath),
    );
  }

  async uninstall(input: {
    clientId: AgentClientId;
    rootPath: string;
    approvedPlanHash: string;
  }): Promise<AgentClientInspection> {
    const client = this.clients.get(input.clientId);
    const draft = await client.planUninstall(input.rootPath);
    if (draft.issues.some((issue) => issue.severity === "conflict"))
      throw new AgentClientPlanConflictError();
    if (hashDraft(draft) !== input.approvedPlanHash)
      throw new AgentClientPlanApprovalError();
    await client.apply(draft);
    return client.inspect(input.rootPath);
  }

  validate(
    clientId: AgentClientId,
    rootPath: string,
  ): Promise<AgentClientValidation> {
    return this.clients.get(clientId).validate(rootPath);
  }
}
