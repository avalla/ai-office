import { describe, expect, test } from "vitest";
import { parseRuntimeHostStart } from "../../apps/cli/src/runtime-lifecycle.ts";

describe("Runtime lifecycle command compatibility", () => {
  test("recognizes runtime-first start syntax", () => {
    expect(parseRuntimeHostStart(["runtime", "start"])).toEqual({
      kind: "start",
      compatibilityAlias: false,
      unexpectedArguments: [],
    });
  });

  test("retains daemon as a compatibility alias", () => {
    expect(parseRuntimeHostStart(["daemon"])).toEqual({
      kind: "start",
      compatibilityAlias: true,
      unexpectedArguments: [],
    });
  });

  test("does not consume Runtime status or unsupported lifecycle commands", () => {
    expect(parseRuntimeHostStart(["runtime", "status"])).toBeNull();
    expect(parseRuntimeHostStart(["runtime", "restart"])).toBeNull();
  });
});
