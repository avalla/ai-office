import type { GovernanceSnapshot } from "../ports/governance-repository.port.ts";

const value = (text: string | undefined): string => text?.trim() || "—";
export function renderGovernanceMarkdown(
  projectName: string,
  s: GovernanceSnapshot,
): string {
  const lines = [`# Governance — ${projectName}`, "", "## Milestones", ""];
  lines.push(
    ...(s.milestones.length === 0
      ? ["_None._"]
      : s.milestones.map(
          (v) => `- **${v.title}** (${v.status}) — ${value(v.description)}`,
        )),
    "",
    "## Requirements",
    "",
  );
  lines.push(
    ...(s.requirements.length === 0
      ? ["_None._"]
      : s.requirements.map(
          (v) => `- **${v.key}: ${v.title}** (${v.status}) — ${v.description}`,
        )),
    "",
    "## Architecture decisions",
    "",
  );
  lines.push(
    ...(s.adrs.length === 0
      ? ["_None._"]
      : s.adrs.flatMap((v) => [
          `### ${v.title}`,
          "",
          `Status: ${v.status}`,
          "",
          `Context: ${v.context}`,
          "",
          `Decision: ${v.decision}`,
          "",
          `Consequences: ${v.consequences}`,
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
        `- **${review.subjectType}:${review.subjectId}** — ${approval?.decision ?? review.status}; reviewer: ${review.reviewer}${approval === undefined ? "" : `; actor: ${approval.actor}`}`,
      );
    }
  return `${lines.join("\n").trimEnd()}\n`;
}
