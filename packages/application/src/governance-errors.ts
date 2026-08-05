import type { ReviewSubjectType } from "@ai-office/domain/governance/governance.ts";

export class GovernanceCrossProjectReferenceError extends Error {
  constructor(reference: string) {
    super(`${reference} must belong to the same project`);
    this.name = "GovernanceCrossProjectReferenceError";
  }
}

export class GovernanceSubjectNotFoundError extends Error {
  constructor(type: ReviewSubjectType, id: string) {
    super(`Governance subject ${type}:${id} was not found in this project`);
    this.name = "GovernanceSubjectNotFoundError";
  }
}

export class ReviewNotFoundError extends Error {
  constructor(id: string) {
    super(`Review ${id} was not found`);
    this.name = "ReviewNotFoundError";
  }
}

export class ReviewAlreadyFinalizedError extends Error {
  constructor(id: string) {
    super(`Review ${id} is already finalized`);
    this.name = "ReviewAlreadyFinalizedError";
  }
}

export class DuplicateRequirementKeyError extends Error {
  constructor(key: string) {
    super(`Requirement key ${key} already exists in this project`);
    this.name = "DuplicateRequirementKeyError";
  }
}
