import type {
  ApprovalRecord,
  AdrRecord,
  MilestoneRecord,
  RequirementRecord,
  ReviewRecord,
} from "@ai-office/domain/governance/governance.ts";
import { isGovernanceTransitionAllowed } from "@ai-office/domain/governance/governance.ts";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
import { ProjectNotFoundError } from "../errors.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { GovernanceRepository } from "../ports/governance-repository.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";

const required = (value: string, name: string): string => {
  const v = value.trim();
  if (v === "") throw new DomainValidationError(`${name} cannot be empty`);
  return v;
};
export class ManageGovernance {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly governance: GovernanceRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}
  private async project(projectId: string): Promise<void> {
    if ((await this.projects.findById(projectId)) === null)
      throw new ProjectNotFoundError(projectId);
  }
  async createMilestone(input: {
    projectId: string;
    title: string;
    description?: string;
  }): Promise<string> {
    await this.project(input.projectId);
    const now = this.clock.now(),
      id = this.ids.generate();
    const v: MilestoneRecord = {
      id,
      projectId: input.projectId,
      title: required(input.title, "Milestone title"),
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      status: "planned",
      createdAt: now,
      updatedAt: now,
    };
    await this.governance.saveMilestone(v);
    return id;
  }
  async createRequirement(input: {
    projectId: string;
    key: string;
    title: string;
    description: string;
    milestoneId?: string;
  }): Promise<string> {
    await this.project(input.projectId);
    const now = this.clock.now(),
      id = this.ids.generate();
    const v: RequirementRecord = {
      id,
      projectId: input.projectId,
      key: required(input.key, "Requirement key"),
      title: required(input.title, "Requirement title"),
      description: required(input.description, "Requirement description"),
      ...(input.milestoneId === undefined
        ? {}
        : { milestoneId: input.milestoneId }),
      status: "proposed",
      createdAt: now,
      updatedAt: now,
    };
    await this.governance.saveRequirement(v);
    return id;
  }
  async createAdr(input: {
    projectId: string;
    title: string;
    context: string;
    decision: string;
    consequences: string;
  }): Promise<string> {
    await this.project(input.projectId);
    const now = this.clock.now(),
      id = this.ids.generate();
    const v: AdrRecord = {
      id,
      projectId: input.projectId,
      title: required(input.title, "ADR title"),
      context: required(input.context, "ADR context"),
      decision: required(input.decision, "ADR decision"),
      consequences: required(input.consequences, "ADR consequences"),
      status: "proposed",
      createdAt: now,
      updatedAt: now,
    };
    await this.governance.saveAdr(v);
    return id;
  }
  async createReview(input: {
    projectId: string;
    subjectType: ReviewRecord["subjectType"];
    subjectId: string;
    reviewer: string;
  }): Promise<string> {
    await this.project(input.projectId);
    const now = this.clock.now(),
      id = this.ids.generate();
    await this.governance.saveReview({
      id,
      projectId: input.projectId,
      subjectType: input.subjectType,
      subjectId: required(input.subjectId, "Review subject"),
      reviewer: required(input.reviewer, "Reviewer"),
      status: "pending",
      createdAt: now,
    });
    return id;
  }
  async approve(input: {
    projectId: string;
    reviewId: string;
    actor: string;
    rationale?: string;
    decision?: ApprovalRecord["decision"];
  }): Promise<string> {
    await this.project(input.projectId);
    const review = await this.governance.findReview(
      input.reviewId,
      input.projectId,
    );
    if (review === null)
      throw new DomainValidationError(`Review ${input.reviewId} not found`);
    if (review.status !== "pending")
      throw new DomainValidationError(
        `Review ${input.reviewId} is already finalized`,
      );
    const id = this.ids.generate();
    await this.governance.saveApproval({
      id,
      projectId: input.projectId,
      reviewId: input.reviewId,
      decision: input.decision ?? "approved",
      actor: required(input.actor, "Approval actor"),
      ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
      createdAt: this.clock.now(),
    });
    return id;
  }
  async setStatus(input: {
    projectId: string;
    kind: "milestone" | "requirement" | "adr";
    id: string;
    status: string;
  }): Promise<void> {
    await this.project(input.projectId);
    const current = await this.governance.findStatus(
      input.kind,
      input.id,
      input.projectId,
    );
    if (current === null)
      throw new DomainValidationError(`${input.kind} ${input.id} not found`);
    if (!isGovernanceTransitionAllowed(input.kind, current, input.status)) {
      throw new DomainValidationError(
        `Cannot transition ${input.kind} from ${current} to ${input.status}`,
      );
    }
    const updated = await this.governance.updateStatus(
      input.kind,
      input.id,
      input.projectId,
      input.status,
      this.clock.now(),
    );
    if (!updated)
      throw new DomainValidationError(
        `${input.kind} ${input.id} was modified concurrently`,
      );
  }
}
