import { describe, expect, test } from "vitest";
import {
  canonicalLegacyDevelopmentProfile,
  deriveLegacyDevelopmentProfile,
  LegacyDevelopmentProfileError,
  legacyRoleGuidanceDigest,
  type LegacyDevelopmentProfileInput,
} from "@ai-office/application/domain-pack/legacy-development-profile.ts";
import {
  officeTaskKinds,
  type OfficeManifest,
} from "@ai-office/domain/office/office-manifest.ts";
import {
  legacyExpectedProfile,
  legacyProfileInput,
} from "../helpers/legacy-development-fixture.ts";

// GP-09 profile version 1. These vectors are frozen: a different value means
// the mapping or the digest material changed, which is a new profile version.
const fixtureDigest =
  "sha256:96ad6eab62fd50dd9290df6c3c2f471604b9290cc7fb5ee2e4c13ba3c9002efa";
const emptyDigest =
  "sha256:5f040cf62cdf54e2cacf480c04166469a56f75c473b5d6623da8b7a716c114ab";

type Input = LegacyDevelopmentProfileInput;
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

function input(): Mutable<Input> & {
  office: NonNullable<Mutable<Input>["office"]>;
} {
  return structuredClone(legacyProfileInput()) as Mutable<Input> & {
    office: NonNullable<Mutable<Input>["office"]>;
  };
}

function changed(change: (value: ReturnType<typeof input>) => void): Input {
  const value = input();
  change(value);
  return value;
}

const digest = (value: Input) =>
  deriveLegacyDevelopmentProfile(value).profileDigest;

function role(value: ReturnType<typeof input>, key: string) {
  return value.roles.find((item) => item.key === key)!;
}

function pipeline(manifest: Mutable<OfficeManifest>, id: string) {
  return manifest.pipelines.find((item) => item.id === id)!;
}

describe("GP-09 legacy development profile version 1", () => {
  test("the committed default-office fixture has the pinned digest and the committed profile", () => {
    const profile = deriveLegacyDevelopmentProfile(legacyProfileInput());
    expect(profile.profileDigest).toBe(fixtureDigest);
    expect(profile.profileVersion).toBe(1);
    expect(JSON.parse(JSON.stringify(profile))).toEqual(
      legacyExpectedProfile("expected-profile.json"),
    );
  });

  test("the same inputs in any order give the same canonical bytes and digest, at any time", () => {
    const first = deriveLegacyDevelopmentProfile(input());
    const reordered = changed((value) => {
      value.roles.reverse();
      value.agents.reverse();
      value.office.manifest.office.roles.reverse();
      value.office.manifest.pipelines.reverse();
    });
    const realNow = Date.now;
    let second;
    try {
      Date.now = () => realNow() + 86_400_000 * 365;
      second = deriveLegacyDevelopmentProfile(reordered);
    } finally {
      Date.now = realNow;
    }
    expect(canonicalLegacyDevelopmentProfile(second)).toBe(
      canonicalLegacyDevelopmentProfile(first),
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.profileDigest).toBe(fixtureDigest);
  });

  test("stage order is semantic and is kept as given", () => {
    const reversed = changed((value) => {
      pipeline(value.office.manifest, "bugfix").stages.reverse();
      // A separation constraint would have to follow its predecessor.
    });
    const profile = deriveLegacyDevelopmentProfile(reversed);
    expect(
      profile.pipelines
        .find((item) => item.id === "bugfix")!
        .stages.map((stage) => stage.id),
    ).toEqual(["review", "fix", "reproduce"]);
    expect(profile.profileDigest).not.toBe(fixtureDigest);
  });

  test("two projects with identical legacy state give identical bytes; no ID, actor or timestamp is carried", () => {
    const other = changed((value) => {
      const renamed = new Map(
        value.roles.map((item) => [
          item.id,
          `role:another-project:${item.key}`,
        ]),
      );
      for (const item of value.roles) item.id = renamed.get(item.id)!;
      for (const item of value.agents) item.roleId = renamed.get(item.roleId)!;
      value.office.manifest.provenance.host = "claude";
    });
    // Storage rows carry more than the derivation reads; none of it leaks.
    const withRowFields = {
      ...other,
      roles: other.roles.map((item) => ({
        ...item,
        projectId: "another-project",
        sourcePath: "/home/operator/agents/role.yaml",
        createdAt: new Date("2026-01-02T03:04:05.000Z"),
        updatedAt: new Date("2026-01-02T03:04:05.000Z"),
      })),
      agents: other.agents.map((item) => ({
        ...item,
        id: `agent:another-project:${item.name}`,
        projectId: "another-project",
        createdAt: new Date("2026-01-02T03:04:05.000Z"),
        updatedAt: new Date("2026-01-02T03:04:05.000Z"),
      })),
    };
    const profile = deriveLegacyDevelopmentProfile(withRowFields);
    const bytes = canonicalLegacyDevelopmentProfile(profile);
    expect(bytes).toBe(
      canonicalLegacyDevelopmentProfile(
        deriveLegacyDevelopmentProfile(legacyProfileInput()),
      ),
    );
    expect(bytes).not.toMatch(
      /another-project|role:|agent:|\/home\/|createdAt|updatedAt|appliedAt|projectId|sourcePath|2026-|"host"|claude|codex/u,
    );
  });

  test("every manifest role, pipeline, stage and stage field appears with an equal value", () => {
    const { office } = legacyProfileInput();
    const manifest = office!.manifest;
    const profile = deriveLegacyDevelopmentProfile(legacyProfileInput());
    const byId = <T extends { id: string }>(items: readonly T[]) =>
      [...items].sort((left, right) => (left.id < right.id ? -1 : 1));
    expect(profile.office).toEqual({ name: manifest.office.name });
    expect(profile.roles.map(({ runtime: _runtime, ...rest }) => rest)).toEqual(
      byId(manifest.office.roles),
    );
    expect(
      profile.pipelines.map((item) => ({
        ...item,
        stages: item.stages.map(
          ({ eligibleAgents: _eligible, ...stage }) => stage,
        ),
      })),
    ).toEqual(byId(manifest.pipelines));
    // Optional fields stay absent when the manifest omits them.
    const bugfix = profile.pipelines.find((item) => item.id === "bugfix")!;
    expect(Object.hasOwn(bugfix, "enforcement")).toBe(false);
    expect(Object.hasOwn(bugfix.stages[0]!, "capabilities")).toBe(false);
    const full = changed((value) => {
      const stage = pipeline(value.office.manifest, "delivery").stages[2]!;
      stage.requiresIndependentApproval = true;
      stage.capabilities = ["repo:read", "fs.write"];
      stage.requiresDifferentAgentFrom = ["implement"];
    });
    expect(
      deriveLegacyDevelopmentProfile(full).pipelines.find(
        (item) => item.id === "delivery",
      )!.stages[2],
    ).toMatchObject({
      requiresIndependentApproval: true,
      capabilities: ["repo:read", "fs.write"],
      requiresDifferentAgentFrom: ["implement"],
    });
  });

  test("task kinds route as the first pipeline naming them, and an unrouted kind is null", () => {
    const profile = deriveLegacyDevelopmentProfile(
      changed((value) => {
        pipeline(value.office.manifest, "discovery").defaultFor = ["release"];
        value.office.manifest.pipelines =
          value.office.manifest.pipelines.filter(
            (item) => item.id !== "release",
          );
      }),
    );
    expect(profile.taskKinds.map((item) => item.kind)).toEqual([
      ...officeTaskKinds,
    ]);
    expect(
      Object.fromEntries(
        profile.taskKinds.map((item) => [item.kind, item.pipelineId]),
      ),
    ).toEqual({
      feature: "delivery",
      bugfix: "bugfix",
      maintenance: "delivery",
      research: null,
      release: "discovery",
    });
    expect(profile.diagnostics).toContainEqual({
      code: "task_kind_unrouted",
      subject: "research",
    });
  });

  test("a stage is eligible for exactly the enabled agents whose role key is its role", () => {
    const profile = deriveLegacyDevelopmentProfile(
      changed((value) => {
        value.agents.push(
          { name: "developer-2", roleId: "role:developer", enabled: true },
          { name: "developer-off", roleId: "role:developer", enabled: false },
        );
        value.agents.find((item) => item.name === "qa")!.enabled = false;
      }),
    );
    const delivery = profile.pipelines.find((item) => item.id === "delivery")!;
    expect(
      Object.fromEntries(
        delivery.stages.map((stage) => [stage.id, stage.eligibleAgents]),
      ),
    ).toEqual({
      design: ["architect"],
      implement: ["developer", "developer-2"],
      review: ["reviewer"],
      verify: [],
    });
    expect(profile.diagnostics).toContainEqual({
      code: "stage_without_eligible_agent",
      subject: "delivery/verify",
    });
  });

  test("mismatches between the manifest and the Runtime are diagnostics, never a failure", () => {
    const profile = deriveLegacyDevelopmentProfile(
      changed((value) => {
        value.roles = value.roles.filter((item) => item.key !== "qa");
        value.agents = value.agents.filter((item) => item.name !== "qa");
      }),
    );
    expect(profile.roles.find((item) => item.id === "qa")!.runtime).toBeNull();
    expect(profile.diagnostics).toEqual(
      expect.arrayContaining([
        { code: "manifest_role_without_runtime_role", subject: "qa" },
        { code: "runtime_role_outside_manifest", subject: "security-reviewer" },
        { code: "runtime_role_outside_manifest", subject: "release-engineer" },
        { code: "runtime_role_without_agent", subject: "release-engineer" },
      ]),
    );
  });

  test("a project with no office gives a valid empty view with its own pinned digest", () => {
    const profile = deriveLegacyDevelopmentProfile({
      office: null,
      roles: [],
      agents: [],
      packBindingPresent: false,
    });
    expect(profile).toMatchObject({
      profileId: "ai-office.legacy-development",
      profileVersion: 1,
      source: "legacy_state",
      executable: false,
      profileDigest: emptyDigest,
      metadata: {
        officeManifestRevision: null,
        packBinding: { present: false },
      },
      office: null,
      roles: [],
      agents: [],
      taskKinds: [],
      pipelines: [],
      runtimeOnly: { roles: [], agents: [] },
      diagnostics: [],
      vocabularyGaps: [],
    });
  });

  test("Runtime roles and agents outside the manifest sit in runtimeOnly with provenance and are never pack content", () => {
    const profile = deriveLegacyDevelopmentProfile(legacyProfileInput());
    expect(profile.runtimeOnly.roles.map((item) => item.key)).toEqual([
      "release-engineer",
      "security-reviewer",
    ]);
    expect(profile.runtimeOnly.agents).toEqual([
      {
        provenance: "runtime_agent_outside_office_manifest",
        name: "security",
        roleKey: "security-reviewer",
        enabled: true,
      },
    ]);
    for (const item of profile.runtimeOnly.roles)
      expect(item.provenance).toBe("runtime_role_outside_office_manifest");
    expect(profile.roles.map((item) => item.id)).toEqual([
      "architect",
      "developer",
      "qa",
      "reviewer",
    ]);
    expect(profile.agents.map((item) => item.name)).toEqual([
      "architect",
      "developer",
      "qa",
      "reviewer",
    ]);
    // No key or value of the resolved pack configuration appears.
    expect(JSON.stringify(profile)).not.toMatch(
      /pack_owned|project_owned|effectiveId|"origin"|pack:|selectedPacks|resolvedPacks/u,
    );
    // Without an office, everything the Runtime holds is Runtime-only.
    const officeless = deriveLegacyDevelopmentProfile({
      ...legacyProfileInput(),
      office: null,
    });
    expect(officeless.roles).toEqual([]);
    expect(officeless.agents).toEqual([]);
    expect(officeless.runtimeOnly.roles).toHaveLength(6);
    expect(officeless.runtimeOnly.agents).toHaveLength(5);
  });

  test("the view says it is a legacy-state profile and not an executable resolved configuration", () => {
    const profile = deriveLegacyDevelopmentProfile(legacyProfileInput());
    expect(profile.source).toBe("legacy_state");
    expect(profile.executable).toBe(false);
    expect(profile.statement).toContain("Legacy-state profile");
    expect(profile.statement).toContain(
      "not an executable resolved configuration",
    );
  });

  test("role guidance is carried as digest and version only", () => {
    const text =
      "# Developer\n\nYou deliver the agreed change with focused tests.\n";
    const base = legacyProfileInput();
    expect(
      base.roles.find((item) => item.key === "developer")!.guidanceText,
    ).toBe(text);
    const profile = deriveLegacyDevelopmentProfile(base);
    const developer = profile.roles.find((item) => item.id === "developer")!;
    expect(developer.runtime!.guidance).toEqual({
      version: 1,
      digest: legacyRoleGuidanceDigest(text),
    });
    expect(JSON.stringify(profile)).not.toContain("You deliver");
    expect(JSON.stringify(profile)).not.toContain("guidanceText");
    // A role with empty guidance has none.
    expect(
      profile.runtimeOnly.roles.find((item) => item.key === "release-engineer")!
        .guidance,
    ).toBeNull();

    const edited = deriveLegacyDevelopmentProfile(
      changed((value) => {
        role(value, "developer").guidanceText =
          `${text}Never approve your own work.\n`;
      }),
    );
    const editedGuidance = edited.roles.find((item) => item.id === "developer")!
      .runtime!.guidance!;
    expect(editedGuidance.digest).not.toBe(developer.runtime!.guidance!.digest);
    expect(edited.profileDigest).not.toBe(profile.profileDigest);
    // The digest is exact: one trailing space is a different guidance.
    expect(legacyRoleGuidanceDigest(`${text} `)).not.toBe(
      legacyRoleGuidanceDigest(text),
    );
    const bumped = deriveLegacyDevelopmentProfile(
      changed((value) => {
        role(value, "developer").guidanceVersion = 2;
      }),
    );
    expect(bumped.profileDigest).not.toBe(profile.profileDigest);
  });

  test.each<[string, (value: ReturnType<typeof input>) => void]>([
    ["office name", (v) => void (v.office.manifest.office.name = "Other")],
    [
      "role title",
      (v) => void (v.office.manifest.office.roles[0]!.title = "Lead"),
    ],
    [
      "role purpose",
      (v) => void (v.office.manifest.office.roles[0]!.purpose = "Lead"),
    ],
    [
      "role responsibility",
      (v) => void v.office.manifest.office.roles[0]!.responsibilities.push("x"),
    ],
    [
      "added manifest role",
      (v) =>
        void v.office.manifest.office.roles.push({
          id: "writer",
          title: "Writer",
          purpose: "Write",
          responsibilities: [],
        }),
    ],
    [
      "removed pipeline",
      (v) =>
        void (v.office.manifest.pipelines = v.office.manifest.pipelines.filter(
          (item) => item.id !== "release",
        )),
    ],
    [
      "pipeline name",
      (v) => void (pipeline(v.office.manifest, "bugfix").name = "Defect"),
    ],
    [
      "pipeline description",
      (v) => void (pipeline(v.office.manifest, "bugfix").description = "x"),
    ],
    [
      "pipeline enforcement",
      (v) =>
        void (pipeline(v.office.manifest, "bugfix").enforcement = "enforced"),
    ],
    [
      "routing",
      (v) =>
        void (pipeline(v.office.manifest, "delivery").defaultFor = ["feature"]),
    ],
    [
      "removed stage",
      (v) => void pipeline(v.office.manifest, "delivery").stages.pop(),
    ],
    [
      "stage name",
      (v) =>
        void (pipeline(v.office.manifest, "delivery").stages[0]!.name = "x"),
    ],
    [
      "stage role",
      (v) =>
        void (pipeline(v.office.manifest, "delivery").stages[0]!.roleId = "qa"),
    ],
    [
      "stage objective",
      (v) =>
        void (pipeline(v.office.manifest, "delivery").stages[0]!.objective =
          "x"),
    ],
    [
      "stage check",
      (v) =>
        void pipeline(v.office.manifest, "delivery").stages[0]!.checks.push(
          "x",
        ),
    ],
    [
      "stage approval",
      (v) =>
        void (pipeline(
          v.office.manifest,
          "delivery",
        ).stages[0]!.requiresApproval = true),
    ],
    [
      "stage independent approval",
      (v) =>
        void (pipeline(
          v.office.manifest,
          "delivery",
        ).stages[2]!.requiresIndependentApproval = true),
    ],
    [
      "stage capability",
      (v) =>
        void (pipeline(v.office.manifest, "delivery").stages[0]!.capabilities =
          ["fs.read"]),
    ],
    [
      "stage separation",
      (v) =>
        void (pipeline(
          v.office.manifest,
          "delivery",
        ).stages[2]!.requiresDifferentAgentFrom = ["implement"]),
    ],
    [
      "agent eligibility (disabled)",
      (v) =>
        void (v.agents.find((item) => item.name === "qa")!.enabled = false),
    ],
    [
      "agent eligibility (added agent)",
      (v) =>
        void v.agents.push({ name: "qa-2", roleId: "role:qa", enabled: true }),
    ],
    [
      "agent role",
      (v) =>
        void (v.agents.find((item) => item.name === "qa")!.roleId =
          "role:developer"),
    ],
    ["Runtime role name", (v) => void (role(v, "qa").name = "tester")],
    ["Runtime role version", (v) => void (role(v, "qa").version = 2)],
    [
      "Runtime role capability",
      (v) => void role(v, "qa").capabilities.push("x"),
    ],
    ["Runtime role tool", (v) => void role(v, "qa").tools.push("x")],
    [
      "Runtime role model policy",
      (v) => void (role(v, "qa").modelPolicy = "x"),
    ],
    [
      "Runtime role limit",
      (v) => void (role(v, "qa").limits.maxCostMicros = 750_001n),
    ],
    ["guidance content", (v) => void (role(v, "qa").guidanceText = "Other")],
    [
      "runtimeOnly role field",
      (v) => void (role(v, "security-reviewer").modelPolicy = "balanced"),
    ],
    [
      "runtimeOnly role removed",
      (v) =>
        void (v.roles = v.roles.filter(
          (item) => item.key !== "release-engineer",
        )),
    ],
    [
      "runtimeOnly agent",
      (v) =>
        void (v.agents.find((item) => item.name === "security")!.enabled =
          false),
    ],
  ])("the digest changes with %s", (_name, change) => {
    expect(digest(changed(change))).not.toBe(fixtureDigest);
    expect(digest(input())).toBe(fixtureDigest);
  });

  test("a pack binding changes the metadata field and nothing else", () => {
    const unbound = deriveLegacyDevelopmentProfile(legacyProfileInput());
    const bound = deriveLegacyDevelopmentProfile({
      ...legacyProfileInput(),
      packBindingPresent: true,
    });
    expect(bound.profileDigest).toBe(unbound.profileDigest);
    expect(bound.metadata.packBinding).toEqual({ present: true });
    expect({
      ...bound,
      metadata: { ...bound.metadata, packBinding: { present: false } },
    }).toEqual(unbound);
  });

  test("the manifest revision number is metadata outside the digest", () => {
    const later = deriveLegacyDevelopmentProfile(
      changed((value) => void (value.office.revision = 7)),
    );
    expect(later.metadata.officeManifestRevision).toBe(7);
    expect(later.profileDigest).toBe(fixtureDigest);
  });

  test("the schema-1 vocabulary gaps are listed from the state", () => {
    const { vocabularyGaps } =
      deriveLegacyDevelopmentProfile(legacyProfileInput());
    expect(vocabularyGaps).toEqual(
      expect.arrayContaining([
        {
          code: "pipeline_routes_several_task_kinds",
          subject: "delivery",
          fields: ["defaultFor"],
        },
        {
          code: "pipeline_fields_not_expressible",
          subject: "delivery",
          fields: ["enforcement"],
        },
        {
          code: "stage_fields_not_expressible",
          subject: "delivery",
          fields: [
            "capabilities",
            "checks",
            "name",
            "objective",
            "requiresApproval",
          ],
        },
        {
          code: "role_fields_not_expressible",
          subject: "architect",
          fields: ["responsibilities"],
        },
        {
          code: "runtime_role_fields_not_expressible",
          subject: "release-engineer",
          fields: ["limits", "modelPolicy", "tools", "version"],
        },
        {
          code: "runtime_role_fields_not_expressible",
          subject: "qa",
          fields: ["guidance", "limits", "modelPolicy", "tools", "version"],
        },
      ]),
    );
  });

  test("state that storage cannot hold is refused with a typed error", () => {
    const refused = (change: (value: ReturnType<typeof input>) => void) => {
      try {
        deriveLegacyDevelopmentProfile(changed(change));
      } catch (error) {
        expect(error).toBeInstanceOf(LegacyDevelopmentProfileError);
        return (error as LegacyDevelopmentProfileError).code;
      }
      return "accepted";
    };
    expect(
      refused((v) => void v.roles.push({ ...role(v, "qa"), id: "role:qa-2" })),
    ).toBe("legacy_state_invariant");
    expect(refused((v) => void v.agents.push({ ...v.agents[0]! }))).toBe(
      "legacy_state_invariant",
    );
    expect(
      refused(
        (v) =>
          void v.agents.push({ name: "x", roleId: "absent", enabled: true }),
      ),
    ).toBe("legacy_state_invariant");
    expect(refused((v) => void (role(v, "qa").name = "\ud800"))).toBe(
      "profile_not_canonical",
    );
  });
});
