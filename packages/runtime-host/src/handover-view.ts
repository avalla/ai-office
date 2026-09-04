import type {
  HandoverDimensionState,
  ProjectHandoverAssessment,
  ProjectHandoverState,
  RecommendedAction,
} from "@ai-office/domain/project/project-handover.ts";
import type { ProjectHandoverReport } from "@ai-office/application/project-lifecycle/assess-project-handover.ts";

export interface HandoverWriter {
  stdout(message: string): void;
}

const stateMarker: Record<HandoverDimensionState, string> = {
  ready: "✓",
  discovered: "~",
  needs_input: "!",
  not_started: "-",
  unknown: "?",
};

const stateSummary: Record<ProjectHandoverState, string> = {
  unknown: "unknown (the runtime could not be consulted)",
  not_connected: "not connected",
  not_imported: "connected, repository not imported",
  needs_handover: "handover incomplete",
  in_progress: "handover in progress",
  ready: "ready",
};

const wrapWidth = 72;

function wrap(text: string, indent: string): string[] {
  const words = text.split(/\s+/u).filter((word) => word !== "");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length + indent.length > wrapWidth) {
      if (current !== "") lines.push(`${indent}${current}`);
      current = word;
    } else current = candidate;
  }
  if (current !== "") lines.push(`${indent}${current}`);
  return lines;
}

function padded(value: string, width: number): string {
  return value.length >= width
    ? value
    : value + " ".repeat(width - value.length);
}

/**
 * First-run welcome. It is printed only when an install established a new
 * repository-to-runtime connection, so ordinary reconciliation stays quiet.
 */
export function renderWelcome(io: HandoverWriter): void {
  const lines = ["AI OFFICE", "Your virtual office is ready"];
  const width = Math.max(...lines.map((line) => line.length)) + 4;
  io.stdout(`╭${"─".repeat(width)}╮`);
  for (const line of lines) io.stdout(`│  ${padded(line, width - 2)}│`);
  io.stdout(`╰${"─".repeat(width)}╯`);
  io.stdout("");
}

function renderAction(
  action: RecommendedAction,
  io: HandoverWriter,
  index: number,
): void {
  io.stdout(`  ${index}. ${action.title}`);
  for (const line of wrap(action.reason, "     ")) io.stdout(line);
  if (action.command !== undefined) io.stdout(`     ${action.command}`);
  if (action.prompt !== undefined) {
    io.stdout("     Ask your AI client:");
    for (const line of wrap(`"${action.prompt}"`, "       ")) io.stdout(line);
  }
}

/**
 * Compact contextual guidance embedded in richer output such as install.
 */
export function renderNextSteps(
  assessment: ProjectHandoverAssessment,
  io: HandoverWriter,
): void {
  io.stdout("Next");
  if (assessment.recommendedActions.length === 0)
    io.stdout("  no recommended action");
  assessment.recommendedActions.forEach((action, index) =>
    renderAction(action, io, index + 1),
  );
  if (assessment.suggestedPrompts.length > 0) {
    io.stdout("");
    io.stdout("Try asking your AI client");
    for (const prompt of assessment.suggestedPrompts)
      for (const line of wrap(`"${prompt}"`, "  ")) io.stdout(line);
  }
  io.stdout("");
  io.stdout("Commands");
  io.stdout("  ai-office next");
  io.stdout("  ai-office status");
}

/**
 * One-line pointer used by status so ordinary inspection stays compact.
 */
export function renderStatusGuidance(
  assessment: ProjectHandoverAssessment,
  io: HandoverWriter,
): void {
  const action = assessment.recommendedActions[0];
  io.stdout("");
  io.stdout("Next");
  io.stdout(`  handover: ${stateSummary[assessment.state]}`);
  if (action !== undefined) io.stdout(`  ${action.title}`);
  io.stdout("  ai-office next");
}

export function renderHandoverReport(
  report: ProjectHandoverReport,
  io: HandoverWriter,
): void {
  const { handover } = report;
  io.stdout("AI Office · Next steps");
  io.stdout("");
  io.stdout("Project");
  io.stdout(`  name: ${report.project.name ?? "unavailable"}`);
  io.stdout(`  id: ${report.project.id ?? "unavailable"}`);
  io.stdout(`  root: ${report.project.root}`);
  io.stdout("");
  io.stdout("Handover");
  io.stdout(`  state: ${handover.state}`);
  io.stdout(`  repository: ${handover.repository}`);
  const width = Math.max(
    ...handover.dimensions.map((entry) => entry.title.length),
  );
  for (const entry of handover.dimensions)
    io.stdout(
      `  ${stateMarker[entry.state]} ${padded(entry.title, width)}  ${entry.detail}`,
    );
  const { blocking, advisory } = handover.openQuestions;
  if (blocking > 0 || advisory > 0)
    io.stdout(`  open questions: ${blocking} blocking, ${advisory} advisory`);
  io.stdout("");
  renderNextSteps(handover, io);
}
