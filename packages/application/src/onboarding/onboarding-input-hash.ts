import { createHash } from "node:crypto";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import type { OnboardingPromptContext } from "./onboarding-prompt.ts";
import { onboardingPromptVersion } from "./generated-onboarding-schema.ts";

export function onboardingInputHash(context: OnboardingPromptContext): string {
  return createHash("sha256")
    .update(
      canonicalStringify({
        promptVersion: onboardingPromptVersion,
        round: context.round,
        project: context.project,
        facts: context.facts,
        answers: context.answers,
        questions: context.questions,
      }),
      "utf8",
    )
    .digest("hex");
}
