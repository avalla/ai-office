import type { GovernanceSnapshot } from "../ports/governance-repository.port.ts";

const inline = (text: string): string =>
  text
    .trim()
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_[\]#|])/g, "\\$1");

const value = (text: string | undefined): string =>
  text === undefined || text.trim() === "" ? "—" : inline(text);

const quoted = (text: string): string[] => {
  const normalized = text.trim().replace(/\r\n?/g, "\n");
  return (normalized === "" ? ["—"] : normalized.split("\n")).map(
    (line) => `> ${line}`,
  );
};
export function renderGovernanceMarkdown(
  projectName: string,
  s: GovernanceSnapshot,
): string {
  const lines = [`# Governance — ${projectName}`, "", "## Milestones", ""];
  lines.push(
    ...(s.milestones.length === 0
      ? ["_None._"]
      : s.milestones.map(
          (v) =>
            `- **${inline(v.title)}** (${v.status}) — ${value(v.description)}`,
        )),
    "",
    "## Requirements",
    "",
  );
  lines.push(
    ...(s.requirements.length === 0
      ? ["_None._"]
      : s.requirements.map(
          (v) =>
            `- **${inline(v.key)}: ${inline(v.title)}** (${v.status}) — ${inline(v.description)}`,
        )),
    "",
    "## Architecture decisions",
    "",
  );
  lines.push(
    ...(s.adrs.length === 0
      ? ["_None._"]
      : s.adrs.flatMap((v) => [
          `### ${inline(v.title)}`,
          "",
          `Status: ${v.status}`,
          "",
          "**Context**",
          "",
          ...quoted(v.context),
          "",
          "**Decision**",
          "",
          ...quoted(v.decision),
          "",
          "**Consequences**",
          "",
          ...quoted(v.consequences),
        ])),
    "",
    "## Reviews and approvals",
    "",
  );
  if (s.reviews.length === 0) lines.push("_None._");
  else
    for (const review of s.reviews) {
      const approval = s.approvals.find((a) => a.reviewId === review.id);
      lines.push(
        `- **${review.subjectType}:${inline(review.subjectId)}** — ${approval?.decision ?? review.status}; reviewer: ${inline(review.reviewer.displayName ?? review.reviewer.id)}${approval === undefined ? "" : `; actor: ${inline(approval.actor.displayName ?? approval.actor.id)}`}`,
      );
    }
  return `${lines.join("\n").trimEnd()}\n`;
}
