import type {
  ProjectProfileEntry,
  ProjectProfileSnapshot,
  ProjectQuestion,
} from "@ai-office/domain/project/project-profile.ts";

function formatValue(value: unknown): string {
  if (typeof value === "string") return value.replaceAll("\n", " ");
  return JSON.stringify(value);
}

function entryLines(entries: ProjectProfileEntry[]): string[] {
  if (entries.length === 0) return ["- None"];
  return entries.map(
    (entry) =>
      `- \`${entry.category}/${entry.key}\`: ${formatValue(entry.value)}`,
  );
}

function questionLines(questions: ProjectQuestion[]): string[] {
  if (questions.length === 0) return ["- None"];
  return questions.map(
    (question) => `- \`${question.id}\`: ${question.question}`,
  );
}

function generatedQuestionLines(questions: ProjectQuestion[]): string[] {
  if (questions.length === 0) return ["- None"];
  return questions.map(
    (question) =>
      `- \`${question.id}\` (${question.answerCategory}, ${question.answerType}, ${question.answer === undefined ? "open" : "answered"}): ${question.question}`,
  );
}

export function renderProjectProfileMarkdown(
  profile: ProjectProfileSnapshot,
): string {
  return [
    `# Project profile: ${profile.project.name}`,
    "",
    `Project ID: \`${profile.project.id}\``,
    "",
    "## Detected facts",
    "",
    ...entryLines(profile.detectedFacts),
    "",
    "## Inferences",
    "",
    ...entryLines(profile.inferences),
    "",
    "## Confirmed preferences",
    "",
    ...entryLines(profile.confirmedPreferences),
    "",
    "## Constraints",
    "",
    ...entryLines(profile.constraints),
    "",
    "## Goals",
    "",
    ...entryLines(profile.goals),
    "",
    "## Agent permissions",
    "",
    ...entryLines(profile.permissions),
    "",
    "## LLM-generated onboarding questions",
    "",
    ...generatedQuestionLines(profile.generatedOnboardingQuestions),
    "",
    "## Open questions",
    "",
    ...questionLines(profile.openQuestions),
    "",
  ].join("\n");
}
