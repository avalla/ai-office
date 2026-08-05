import { createHash } from "node:crypto";
import type { CanonicalActionPayload } from "@ai-office/domain/capability/action-request.ts";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";

export function hashCanonicalActionPayload(payload: CanonicalActionPayload): {
  canonical: string;
  hash: string;
} {
  const canonical = canonicalStringify(payload);
  return {
    canonical,
    hash: createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
}
