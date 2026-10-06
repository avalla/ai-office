import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { deriveLegacyDevelopmentProfile } from "@ai-office/application/domain-pack/legacy-development-profile.ts";
import { resolveProjectConfiguration } from "@ai-office/application/domain-pack/resolve-project-configuration.ts";
import { officeTaskKinds } from "@ai-office/domain/office/office-manifest.ts";
import {
  computeArtifactDigest,
  contributionKinds,
  verifyDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import {
  classifyLegacyFields,
  completenessViolations,
  developmentPackBytes,
  developmentPackId,
  developmentPackManifestDigest,
  developmentPackVersion,
  entryKey,
  executionParityTaskId,
  legacyRoleIds,
  missingGp09Gaps,
  mutatedDevelopmentPackBytes,
  outsidePackVocabulary,
  outsidePackVocabularyPath,
  parseOutsidePackVocabulary,
  projectLegacyProfile,
  projectResolvedConfiguration,
  repositoryRoot,
  testCatalogWith,
  type ExpressibleSubset,
  type RawPackManifest,
} from "../helpers/development-pack-parity.ts";
import { legacyProfileInput } from "../helpers/legacy-development-fixture.ts";

// GP-10A: the development pack as a committed reference artifact, and
// expressible-subset parity with the legacy development defaults. Pure: no
// storage and no Runtime. The same comparison on stored state and on the
// shipped defaults is in tests/integration/development-pack-parity.test.ts.

const legacyCapabilities = [
  "approve_or_reject",
  "assess_security",
  "assess_tradeoffs",
  "create_patch",
  "decompose_work",
  "derive_test_cases",
  "inspect_code",
  "inspect_diff",
  "inspect_project",
  "inspect_tests",
  "modify_code",
  "propose_adr",
  "report_regressions",
  "run_tests",
];

/** The GP-09 fixture office as the pure derivation sees it. */
const fixtureProfile = deriveLegacyDevelopmentProfile(legacyProfileInput());

/** The resolved configuration of a project bound to exactly this manifest. */
function resolvedSubset(bytes: Uint8Array): ExpressibleSubset {
  const { catalog, pack } = testCatalogWith(bytes);
  return projectResolvedConfiguration(
    resolveProjectConfiguration({
      projectId: "gp10a",
      binding: { projectId: "gp10a", configurationRevision: 1, packs: [pack] },
      definitions: {
        projectId: "gp10a",
        revision: 0,
        owned: [],
        overrides: [],
      },
      catalog,
      coreContractVersion: catalog.coreContractVersion,
    }),
  );
}

describe("GP-10A development pack reference artifact", () => {
  test("the committed manifest verifies against core contract 1 and its identity and bytes are pinned", () => {
    const bytes = developmentPackBytes();
    const manifest = verifyDomainPackManifest(bytes, 1);
    expect({
      id: manifest.id,
      version: manifest.version,
      manifestDigest: manifest.manifestDigest,
    }).toEqual({
      id: developmentPackId,
      version: developmentPackVersion,
      manifestDigest: developmentPackManifestDigest,
    });
    expect(developmentPackId).toBe("org.ai-office.development");
    expect(developmentPackVersion).toBe("0.1.0");
    // The exact file: a byte that changes at this version fails here.
    expect(computeArtifactDigest(bytes)).toBe(
      "sha256:1bc115b6caa1f1bce66d65654f6d68ab96dc08b94a924888ee50ffa16db3592d",
    );
    expect(manifest.coreContract).toEqual({ minInclusive: 1, maxExclusive: 2 });
    expect(manifest.dependencies).toEqual([]);
    // A changed manifest has another digest, so the pin cannot hold by chance.
    expect(
      verifyDomainPackManifest(
        mutatedDevelopmentPackBytes((copy) => {
          copy.contributions.roles![0]!.title = "Architect";
        }),
        1,
      ).manifestDigest,
    ).not.toBe(developmentPackManifestDigest);
  });

  test("it declares exactly the four roles, the four agents naming them, the five task types and the 14 role capabilities", () => {
    const { contributions } = verifyDomainPackManifest(developmentPackBytes());
    expect(contributions.roles).toEqual([
      {
        id: "architect",
        title: "Software Architect",
        description:
          "Turn the agreed outcome into a coherent, verifiable technical design",
        capabilities: [
          "assess_tradeoffs",
          "decompose_work",
          "inspect_project",
          "propose_adr",
        ],
      },
      {
        id: "developer",
        title: "Developer",
        description:
          "Deliver a scoped, maintainable implementation backed by relevant validation",
        capabilities: [
          "create_patch",
          "inspect_code",
          "modify_code",
          "run_tests",
        ],
      },
      {
        id: "reviewer",
        title: "Reviewer",
        description:
          "Independently assess correctness, security, scope, and architectural integrity",
        capabilities: [
          "approve_or_reject",
          "assess_security",
          "inspect_diff",
          "inspect_tests",
        ],
      },
      {
        id: "qa",
        title: "Quality Assurance",
        description:
          "Produce reproducible evidence of acceptance behavior and regression safety",
        capabilities: ["derive_test_cases", "report_regressions", "run_tests"],
      },
    ]);
    // An agent names its role and carries nothing else.
    expect(contributions.agents).toEqual([
      { id: "architect", role: "architect" },
      { id: "developer", role: "developer" },
      { id: "reviewer", role: "reviewer" },
      { id: "qa", role: "qa" },
    ]);
    expect(contributions.taskTypes).toEqual(
      ["feature", "bugfix", "maintenance", "research", "release"].map((id) => ({
        id,
      })),
    );
    expect(contributions.taskTypes.map((type) => type.id)).toEqual([
      ...officeTaskKinds,
    ]);
    // Capabilities are labels: an ID and nothing else.
    expect(contributions.capabilities).toEqual(
      legacyCapabilities.map((id) => ({ id })),
    );
  });

  test("it holds no GP-10B or GP-10C content and no agent capability", () => {
    const { contributions } = verifyDomainPackManifest(developmentPackBytes());
    for (const kind of contributionKinds)
      expect([kind, contributions[kind].length]).toEqual([
        kind,
        { roles: 4, agents: 4, taskTypes: 5, capabilities: 14 }[
          kind as string
        ] ?? 0,
      ]);
    for (const agent of contributions.agents)
      expect(Object.keys(agent).sort()).toEqual(["id", "role"]);
    // The raw file agrees: no key the parser would have had to accept.
    const raw = JSON.parse(
      new TextDecoder().decode(developmentPackBytes()),
    ) as RawPackManifest;
    for (const kind of [
      "workflows",
      "prompts",
      "knowledge",
      "policies",
      "artifactTypes",
      "evidenceTypes",
      "validators",
    ])
      expect(raw.contributions[kind]).toEqual([]);
  });
});

describe("GP-10A expressible-subset parity on the GP-09 fixture office", () => {
  test("the resolved configuration of a project bound to the pack equals the legacy profile over roles, agents and task types", () => {
    const legacy = projectLegacyProfile(fixtureProfile);
    expect(resolvedSubset(developmentPackBytes())).toEqual(legacy);
    // The shape is not empty, and `purpose` is what `description` holds.
    expect(legacy.roles.map((role) => role.id)).toEqual([...legacyRoleIds]);
    expect(legacy.agents).toEqual(
      legacyRoleIds.map((id) => ({ id, role: id })),
    );
    expect(legacy.taskTypes).toEqual([...officeTaskKinds].sort());
    for (const role of fixtureProfile.roles)
      expect(
        legacy.roles.find((projected) => projected.id === role.id)?.description,
      ).toBe(role.purpose);
    expect(
      [...new Set(legacy.roles.flatMap((role) => role.capabilities))].sort(),
    ).toEqual(legacyCapabilities);
  });

  test.each<[string, (manifest: RawPackManifest) => void]>([
    [
      "a role title",
      (manifest) => {
        manifest.contributions.roles![3]!.title = "QA";
      },
    ],
    [
      "a role description",
      (manifest) => {
        manifest.contributions.roles![1]!.description += ".";
      },
    ],
    [
      "a role capability removed",
      (manifest) => {
        manifest.contributions.roles![3]!.capabilities = [
          "derive_test_cases",
          "report_regressions",
        ];
      },
    ],
    [
      "a role capability added",
      (manifest) => {
        manifest.contributions.roles![0]!.capabilities!.push("run_tests");
      },
    ],
    [
      "an agent role",
      (manifest) => {
        manifest.contributions.agents![3]!.role = "reviewer";
      },
    ],
    [
      "a task-type ID",
      (manifest) => {
        manifest.contributions.taskTypes![4]!.id = "hotfix";
      },
    ],
  ])("changing %s in a copy of the pack breaks parity", (_name, mutate) => {
    expect(resolvedSubset(mutatedDevelopmentPackBytes(mutate))).not.toEqual(
      projectLegacyProfile(fixtureProfile),
    );
  });

  test("a capability order is not compared and a capability change is", () => {
    const reordered = structuredClone(fixtureProfile);
    const runtime = reordered.roles[0]!.runtime!;
    (runtime.capabilities as string[]).reverse();
    expect(runtime.capabilities).not.toEqual(
      fixtureProfile.roles[0]!.runtime!.capabilities,
    );
    expect(projectLegacyProfile(reordered)).toEqual(
      projectLegacyProfile(fixtureProfile),
    );
    (runtime.capabilities as string[]).pop();
    expect(projectLegacyProfile(reordered)).not.toEqual(
      projectLegacyProfile(fixtureProfile),
    );
  });
});

describe("GP-10A legacy fields outside the pack vocabulary", () => {
  const vocabulary = outsidePackVocabulary();
  const keys = vocabulary.entries.map(entryKey);

  test("the committed list is well formed, names the pack and the claim, and every entry names one of the three owners", () => {
    expect(vocabulary.schemaVersion).toBe(1);
    expect(vocabulary.pack).toEqual({
      id: developmentPackId,
      version: developmentPackVersion,
    });
    expect(vocabulary.claim).toBe("expressible-subset parity");
    expect(Object.keys(vocabulary.owners)).toEqual([
      "GP-10B",
      "GP-10C",
      executionParityTaskId,
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of vocabulary.entries)
      expect(Object.keys(vocabulary.owners)).toContain(entry.owner);
    // An entry without an owner, or with another one, is rejected.
    const raw = JSON.parse(readFileSync(outsidePackVocabularyPath, "utf8")) as {
      entries: Record<string, unknown>[];
    };
    const { owner: _owner, ...ownerless } = raw.entries[0]!;
    expect(() =>
      parseOutsidePackVocabulary({ ...raw, entries: [ownerless] }),
    ).toThrow(/missing or unknown owner/u);
    expect(() =>
      parseOutsidePackVocabulary({
        ...raw,
        entries: [{ ...raw.entries[0], owner: "GP-11" }],
      }),
    ).toThrow(/missing or unknown owner/u);
  });

  test("it holds every field the scope names, with its owner", () => {
    expect(
      vocabulary.entries.map((entry) => [entryKey(entry), entry.owner]),
    ).toEqual([
      ["office_role.responsibilities", "GP-10B"],
      ["runtime_role.name", executionParityTaskId],
      ["runtime_role.version", executionParityTaskId],
      ["runtime_role.capabilities#order", executionParityTaskId],
      ["runtime_role.tools", "GP-10C"],
      ["runtime_role.modelPolicy", executionParityTaskId],
      ["runtime_role.limits", executionParityTaskId],
      ["runtime_role.guidance", "GP-10B"],
      ["agent.enabled", executionParityTaskId],
      ["task_kind.pipelineId", "GP-10B"],
      ["pipeline.defaultFor", "GP-10B"],
      ["pipeline.enforcement", "GP-10B"],
      ["stage.name", "GP-10B"],
      ["stage.objective", "GP-10B"],
      ["stage.checks", "GP-10B"],
      ["stage.requiresApproval", "GP-10B"],
      ["stage.capabilities", "GP-10B"],
    ]);
    // The minimum the approved scope requires, named one by one.
    for (const required of [
      "runtime_role.tools",
      "runtime_role.modelPolicy",
      "runtime_role.limits",
      "runtime_role.guidance",
      "office_role.responsibilities",
      "runtime_role.name",
      "runtime_role.capabilities#order",
      "agent.enabled",
      // Pipeline, approval and check semantics.
      "task_kind.pipelineId",
      "pipeline.defaultFor",
      "pipeline.enforcement",
      "stage.requiresApproval",
      "stage.checks",
    ])
      expect(keys).toContain(required);
  });

  test("it carries every GP-09 vocabulary gap of the default state, and claims no GP-09 gap that GP-09 does not report", () => {
    expect(fixtureProfile.vocabularyGaps.length).toBeGreaterThan(0);
    expect(missingGp09Gaps(fixtureProfile, vocabulary)).toEqual([]);
    // Role side, spelled out: each default role's gaps are in the list.
    for (const id of legacyRoleIds) {
      const gaps = fixtureProfile.vocabularyGaps.filter(
        (gap) => gap.subject === id && /role_fields/u.test(gap.code),
      );
      expect(gaps.map((gap) => [gap.code, gap.fields])).toEqual([
        ["role_fields_not_expressible", ["responsibilities"]],
        [
          "runtime_role_fields_not_expressible",
          ["guidance", "limits", "modelPolicy", "tools", "version"],
        ],
      ]);
    }
    // Without one of them the check reports it.
    expect(
      missingGp09Gaps(fixtureProfile, {
        ...vocabulary,
        entries: vocabulary.entries.filter(
          (entry) => entryKey(entry) !== "runtime_role.tools",
        ),
      }),
    ).toEqual(["runtime_role_fields_not_expressible:runtime_role.tools"]);
    // Every GP-09 code an entry cites does report that field.
    const reported = new Set(
      fixtureProfile.vocabularyGaps.flatMap((gap) =>
        gap.fields.map((field) => `${gap.code}:${field}`),
      ),
    );
    for (const entry of vocabulary.entries)
      if (entry.gp09Gap !== null)
        expect(reported).toContain(`${entry.gp09Gap}:${entry.field}`);
  });

  test("the Runtime role name is in the list although GP-09's gap list does not have it", () => {
    for (const gap of fixtureProfile.vocabularyGaps)
      if (gap.code === "runtime_role_fields_not_expressible")
        expect(gap.fields).not.toContain("name");
    expect(
      vocabulary.entries.find(
        (entry) => entryKey(entry) === "runtime_role.name",
      ),
    ).toMatchObject({ gp09Gap: null, owner: executionParityTaskId });
    // The field exists in the legacy state and the projection ignores it.
    expect(fixtureProfile.roles[0]!.runtime!.name).toBe("software-architect");
    expect(classifyLegacyFields(fixtureProfile)).toContainEqual({
      key: "runtime_role.name",
      projected: false,
    });
  });

  test("every legacy field of the roles, agents and task kinds is in the projection or in the list, never both and never neither", () => {
    expect(classifyLegacyFields(fixtureProfile)).toEqual([
      { key: "agent.enabled", projected: false },
      { key: "agent.name", projected: true },
      { key: "agent.roleId", projected: true },
      { key: "office_role.id", projected: true },
      { key: "office_role.purpose", projected: true },
      { key: "office_role.responsibilities", projected: false },
      { key: "office_role.title", projected: true },
      { key: "runtime_role.capabilities", projected: true },
      { key: "runtime_role.guidance", projected: false },
      { key: "runtime_role.limits", projected: false },
      { key: "runtime_role.modelPolicy", projected: false },
      { key: "runtime_role.name", projected: false },
      { key: "runtime_role.tools", projected: false },
      { key: "runtime_role.version", projected: false },
      { key: "task_kind.kind", projected: true },
      { key: "task_kind.pipelineId", projected: false },
    ]);
    expect(completenessViolations(fixtureProfile, vocabulary)).toEqual([]);
    // Neither: a field dropped from the list.
    expect(
      completenessViolations(fixtureProfile, {
        ...vocabulary,
        entries: vocabulary.entries.filter(
          (entry) => entryKey(entry) !== "agent.enabled",
        ),
      }),
    ).toEqual(["agent.enabled is in neither the projection nor the list"]);
    // Both: a projected field also listed, and an entry for no field at all.
    expect(
      completenessViolations(fixtureProfile, {
        ...vocabulary,
        entries: [
          ...vocabulary.entries,
          { ...vocabulary.entries[0]!, field: "title" },
          { ...vocabulary.entries[0]!, field: "seniority" },
        ],
      }),
    ).toEqual([
      "office_role.title is in both the projection and the list",
      "office_role.seniority names no legacy field",
    ]);
  });
});

describe("GP-10A documentation", () => {
  const plan = readFileSync(
    join(repositoryRoot, "docs/development/generic-core-domain-packs.md"),
    "utf8",
  );
  const start = plan.indexOf(
    "\n## GP-10A development roles and task defaults\n",
  );
  const section = plan.slice(start, plan.indexOf("\n## ", start + 1));
  /** Prose as one line: no wrapping, no block-quote marker. */
  const prose = section.replace(/\n>/gu, "\n").replace(/\s+/gu, " ");

  test("the plan carries the formal scope and the anti-goal verbatim and names the claim", () => {
    expect(start).toBeGreaterThan(0);
    expect(prose).toContain(
      "Define the development domain pack as a committed reference artifact and prove parity with the legacy development defaults over the subset expressible by the current pack contract. No Runtime consumption, catalog registration, implicit adoption, or legacy-path removal occurs in GP-10A.",
    );
    expect(prose).toContain(
      "GP-10A MUST NOT make the development pack authoritative for Runtime execution.",
    );
    expect(prose).toContain("**expressible-subset parity**");
    expect(prose).toContain("it is not execution parity");
    expect(prose).toContain(executionParityTaskId);
    expect(prose).toContain("Nothing was removed from the legacy path.");
    expect(section).toContain("### Implementation record");
  });

  test("the plan records the two points found after GP-09", () => {
    expect(prose).toMatch(
      /\*\*Runtime role name\.\*\* GP-09's `runtime_role_fields_not_expressible` gap .* does not list the Runtime role `name`/u,
    );
    expect(prose).toContain("The frozen GP-09 profile is not edited.");
    expect(prose).toMatch(
      /\*\*Synthetic guidance in the GP-09 fixture\.\*\* .* parity with the fixture does not prove parity with what the repository ships/u,
    );
  });

  test("the plan's list of fields outside the pack vocabulary is the committed list, entry for entry", () => {
    const subjects = {
      office_role: "office role",
      runtime_role: "Runtime role",
      agent: "agent",
      task_kind: "task kind",
      pipeline: "pipeline",
      stage: "stage",
    };
    const rows = section
      .split("\n")
      .filter((line) => line.startsWith("| "))
      .map((line) =>
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      )
      .filter((cells) => cells.length === 4)
      .slice(2);
    expect(rows).toEqual(
      outsidePackVocabulary().entries.map((entry) => [
        subjects[entry.subject],
        entry.aspect === undefined
          ? `\`${entry.field}\``
          : `capability ${entry.aspect}`,
        entry.owner === executionParityTaskId ? "a45ddb12" : entry.owner,
        entry.gp09Gap === null
          ? expect.stringMatching(/^none/u)
          : `\`${entry.gp09Gap}\``,
      ]),
    );
  });

  test("no current document says the defaults left the legacy path or claims execution parity for GP-10A", () => {
    const row = plan
      .split("\n")
      .find((line) => line.startsWith("| GP-10A — "))!;
    expect(row).not.toMatch(/\bmov(?:e|ed|es|ing)\b/iu);
    expect(row).toContain("expressible-subset parity");
    expect(section).not.toMatch(/\bmov(?:e|ed|es|ing)\b/iu);
    const stage = plan.slice(
      plan.indexOf("4. **Extraction:**"),
      plan.indexOf("5. **Opt-in adoption:**"),
    );
    expect(stage).not.toMatch(/\bmov(?:e|ed|es|ing)\b/iu);
    expect(stage).toContain("removes nothing");
    const roadmap = readFileSync(
      join(repositoryRoot, "docs/development/roadmap.md"),
      "utf8",
    ).replace(/\s+/gu, " ");
    expect(roadmap).toContain("expressible-subset parity");
    expect(roadmap).toMatch(
      /GP-10A defines .*? It proves expressible-subset parity: .*? It is not execution parity: /u,
    );
    expect(roadmap).toContain("nothing was removed from the legacy path");
  });
});
