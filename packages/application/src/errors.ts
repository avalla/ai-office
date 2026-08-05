export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} not found`);
    this.name = "ProjectNotFoundError";
  }
}


export class ProjectQuestionNotFoundError extends Error {
  constructor(projectId: string, questionId: string) {
    super(`Question ${questionId} was not found for project ${projectId}`);
    this.name = "ProjectQuestionNotFoundError";
  }
}

export class ProjectQuestionAlreadyAnsweredError extends Error {
  constructor(questionId: string) {
    super(`Question ${questionId} has already been answered`);
    this.name = "ProjectQuestionAlreadyAnsweredError";
  }
}

export class InvalidProjectAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectAnswerError";
  }
}
