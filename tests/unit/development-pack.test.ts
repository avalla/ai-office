import { createHash } from "node:crypto";
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
  defaultStateViolations,
  developmentPackBytes,
  developmentPackId,
  developmentPackManifestDigest,
  developmentPackVersion,
  entryKey,
  descriptiveExtensionTaskId,
  executionParityTaskId,
  legacyRoleIds,
  legacyRoutes,
  missingGp09Gaps,
  mutatedDevelopmentPackBytes,
  outsidePackVocabulary,
  outsidePackVocabularyPath,
  parseOutsidePackVocabulary,
  policyTaskId,
  projectLegacyProfile,
  projectResolvedConfiguration,
  repositoryRoot,
  testCatalogWith,
  unexpressedLegacyRoute,
  type ExpressibleSubset,
  type RawPackManifest,
} from "../helpers/development-pack-parity.ts";
import { legacyProfileInput } from "../helpers/legacy-development-fixture.ts";

// GP-10A and GP-10B-1: the development pack as a committed reference
// artifact, and expressible-subset parity with the legacy development
// defaults. Pure: no storage and no Runtime. The same comparison on stored
// state and on the shipped defaults is in
// tests/integration/development-pack-parity.test.ts.

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
    expect(developmentPackVersion).toBe("0.2.0");
    // The exact file: a byte that changes at this version fails here.
    expect(computeArtifactDigest(bytes)).toBe(
      "sha256:3316f4f9683edafa3c827c11b6b6f1b5a88fc8265e48565b01e2bd0b2dee2518",
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

  test("it holds no prompt, knowledge, policy, artifact type, evidence type or validator, and no agent capability, prompt or knowledge", () => {
    const { contributions } = verifyDomainPackManifest(developmentPackBytes());
    for (const kind of contributionKinds)
      expect([kind, contributions[kind].length]).toEqual([
        kind,
        { roles: 4, agents: 4, taskTypes: 5, capabilities: 14, workflows: 4 }[
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
        // The one task type no workflow names.
        manifest.contributions.taskTypes![2]!.id = "hotfix";
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
  const stageEntry = (field: string) =>
    vocabulary.entries.find((entry) => entryKey(entry) === `stage.${field}`)!;

  test("the committed list is well formed, names the pack and the claim, and every entry names one of the four owners", () => {
    expect(vocabulary.schemaVersion).toBe(2);
    expect(vocabulary.pack).toEqual({
      id: developmentPackId,
      version: developmentPackVersion,
    });
    expect(vocabulary.claim).toBe("expressible-subset parity");
    expect(Object.keys(vocabulary.owners)).toEqual([
      "GP-10B-2",
      "GP-25",
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
    // So is an entry that does not say whether the default state uses it.
    const { inDefaultState: _inDefaultState, ...unmarked } = raw.entries[0]!;
    expect(() =>
      parseOutsidePackVocabulary({ ...raw, entries: [unmarked] }),
    ).toThrow(/inDefaultState must be true or false/u);
  });

  test("it holds every field the scope names, with its owner", () => {
    expect(
      vocabulary.entries.map((entry) => [entryKey(entry), entry.owner]),
    ).toEqual([
      ["office_role.responsibilities", "GP-10B-2"],
      ["runtime_role.name", executionParityTaskId],
      ["runtime_role.version", executionParityTaskId],
      ["runtime_role.capabilities#order", executionParityTaskId],
      ["runtime_role.tools", "GP-10C"],
      ["runtime_role.modelPolicy", executionParityTaskId],
      ["runtime_role.limits", executionParityTaskId],
      ["runtime_role.guidance", "GP-10B-2"],
      ["agent.enabled", executionParityTaskId],
      ["task_kind.pipelineId", "GP-10B-2"],
      ["pipeline.defaultFor", "GP-10B-2"],
      ["pipeline.enforcement", "GP-25"],
      ["stage.name", "GP-10B-2"],
      ["stage.objective", "GP-10B-2"],
      ["stage.checks", "GP-10B-2"],
      ["stage.requiresApproval", "GP-25"],
      ["stage.capabilities", "GP-25"],
      ["stage.requiresIndependentApproval", "GP-25"],
      ["stage.requiresDifferentAgentFrom", "GP-25"],
    ]);
    expect(keys).toHaveLength(19);
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
      // Approval and separation fields the defaults do not use.
      "stage.requiresIndependentApproval",
      "stage.requiresDifferentAgentFrom",
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
    // Every GP-09 code an entry cites does report that field, unless the
    // entry is marked as unused by the default state.
    expect(defaultStateViolations(fixtureProfile, vocabulary)).toEqual([]);
    expect(
      defaultStateViolations(fixtureProfile, {
        ...vocabulary,
        entries: [
          ...vocabulary.entries,
          { ...stageEntry("checks"), field: "seniority" },
        ],
      }),
    ).toEqual([
      "stage.seniority is marked as used and stage_fields_not_expressible does not report it",
    ]);
  });

  test("the two stage fields the default state does not use are marked as such, and are legacy fields GP-09 reports once a stage uses them", () => {
    const unused = vocabulary.entries.filter((entry) => !entry.inDefaultState);
    expect(
      unused.map((entry) => [entryKey(entry), entry.owner, entry.gp09Gap]),
    ).toEqual([
      [
        "stage.requiresIndependentApproval",
        "GP-25",
        "stage_fields_not_expressible",
      ],
      [
        "stage.requiresDifferentAgentFrom",
        "GP-25",
        "stage_fields_not_expressible",
      ],
    ]);
    for (const entry of unused)
      expect(entry.reason).toContain("The default state does not use it.");
    // The default state has neither field on any stage.
    const stageFields = new Set(
      fixtureProfile.pipelines.flatMap((pipeline) =>
        pipeline.stages.flatMap((stage) => Object.keys(stage)),
      ),
    );
    expect(stageFields).toContain("requiresApproval");
    for (const entry of unused) expect(stageFields).not.toContain(entry.field);
    // An observed field cannot be passed off as unused, and an unused entry
    // needs a GP-09 code that can show it.
    const marked = (key: string, gp09Gap: string | null) => ({
      ...vocabulary,
      entries: vocabulary.entries.map((entry) =>
        entryKey(entry) === key
          ? { ...entry, inDefaultState: false, gp09Gap }
          : entry,
      ),
    });
    expect(
      defaultStateViolations(
        fixtureProfile,
        marked("stage.checks", "stage_fields_not_expressible"),
      ),
    ).toEqual(["stage.checks is marked unused and the state uses it"]);
    expect(
      defaultStateViolations(fixtureProfile, marked("agent.enabled", null)),
    ).toEqual(["agent.enabled is marked unused and cites no GP-09 code"]);
    // Both are real legacy stage fields: in an office whose stage uses them,
    // GP-09 reports each under the code its entry cites. An invented field
    // marked unused is never reported, so it cannot pass this.
    const input = legacyProfileInput();
    const manifest = structuredClone(input.office!.manifest);
    const stages = manifest.pipelines[0]!.stages;
    expect(stages.length).toBeGreaterThan(1);
    Object.assign(stages[1]!, {
      requiresIndependentApproval: true,
      requiresDifferentAgentFrom: [stages[0]!.id],
    });
    const using = deriveLegacyDevelopmentProfile({
      ...input,
      office: { revision: 1, manifest },
    });
    const invented = {
      ...vocabulary,
      entries: [
        ...vocabulary.entries,
        { ...unused[0]!, field: "requiresQuorum" },
      ],
    };
    expect(defaultStateViolations(fixtureProfile, invented)).toEqual([]);
    for (const list of [vocabulary, invented])
      expect(defaultStateViolations(using, list)).toEqual([
        "stage.requiresIndependentApproval is marked unused and the state uses it",
        "stage.requiresDifferentAgentFrom is marked unused and the state uses it",
      ]);
    expect(
      invented.entries
        .filter((entry) => !entry.inDefaultState)
        .map(entryKey)
        .filter(
          (key) =>
            !defaultStateViolations(using, invented).includes(
              `${key} is marked unused and the state uses it`,
            ),
        ),
    ).toEqual(["stage.requiresQuorum"]);
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

  test("every legacy field of the roles, agents, task kinds, pipelines and stages is in the projection or in the list, never both and never neither", () => {
    expect(classifyLegacyFields(fixtureProfile)).toEqual([
      { key: "agent.enabled", projected: false },
      { key: "agent.name", projected: true },
      { key: "agent.roleId", projected: true },
      { key: "office_role.id", projected: true },
      { key: "office_role.purpose", projected: true },
      { key: "office_role.responsibilities", projected: false },
      { key: "office_role.title", projected: true },
      { key: "pipeline.defaultFor", projected: true },
      { key: "pipeline.description", projected: true },
      { key: "pipeline.enforcement", projected: false },
      { key: "pipeline.id", projected: true },
      { key: "pipeline.name", projected: true },
      { key: "runtime_role.capabilities", projected: true },
      { key: "runtime_role.guidance", projected: false },
      { key: "runtime_role.limits", projected: false },
      { key: "runtime_role.modelPolicy", projected: false },
      { key: "runtime_role.name", projected: false },
      { key: "runtime_role.tools", projected: false },
      { key: "runtime_role.version", projected: false },
      { key: "stage.capabilities", projected: false },
      { key: "stage.checks", projected: false },
      { key: "stage.id", projected: true },
      { key: "stage.name", projected: false },
      { key: "stage.objective", projected: false },
      { key: "stage.requiresApproval", projected: false },
      { key: "stage.roleId", projected: true },
      { key: "task_kind.kind", projected: true },
      // Read for every task kind but the one whose route is residue.
      { key: "task_kind.pipelineId", projected: true },
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
    // A delivered part is a claim about a field the projection reads: it
    // cannot be stated for a field the projection ignores, and stating that
    // nothing of a projected field is delivered puts it in both.
    const restated = (key: string, delivered: string | null) => ({
      ...vocabulary,
      entries: vocabulary.entries.map((entry) =>
        entryKey(entry) === key ? { ...entry, delivered } : entry,
      ),
    });
    expect(
      completenessViolations(
        fixtureProfile,
        restated("stage.name", "The name of the first stage."),
      ),
    ).toEqual([
      "stage.name is in neither the projection nor the list",
      "stage.name states a delivered part of a field that is not projected",
    ]);
    expect(
      completenessViolations(
        fixtureProfile,
        restated("task_kind.pipelineId", null),
      ),
    ).toEqual(["task_kind.pipelineId is in both the projection and the list"]);
  });
});

const subjectLabels = {
  office_role: "office role",
  runtime_role: "Runtime role",
  agent: "agent",
  task_kind: "task kind",
  pipeline: "pipeline",
  stage: "stage",
};

const fieldLabel = (entry: { field: string; aspect?: string }): string =>
  entry.aspect === undefined
    ? `\`${entry.field}\``
    : `capability ${entry.aspect}`;

/** The body rows of the Markdown tables of a section with that many cells. */
function tableRows(section: string, cells: number): string[][] {
  return section
    .split("\n")
    .filter((line) => line.startsWith("| "))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((row) => row.length === cells)
    .slice(2);
}

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

  test("the GP-10A table of fields outside the pack vocabulary still names the committed entries, with the owners GP-10A assigned", () => {
    // The current list, with what GP-10B-1 delivers and the current owners,
    // is the table of the GP-10B-1 section; it is compared entry for entry
    // in the GP-10B-1 documentation tests below.
    const rows = tableRows(section, 4);
    expect(rows.map((cells) => cells.slice(0, 2))).toEqual(
      outsidePackVocabulary().entries.map((entry) => [
        subjectLabels[entry.subject],
        fieldLabel(entry),
      ]),
    );
    expect(rows).toHaveLength(19);
    expect(rows.filter((cells) => cells[2] === "GP-10B")).toHaveLength(12);
    expect(prose).toContain(
      "The owners above are the ones GP-10A assigned. GP-10B has since been split, and the GP-10B-1 section holds the current list with the current owners.",
    );
    expect(prose).toContain(
      "The last two rows are legacy stage fields that the default state does not use",
    );
    expect(prose).toMatch(
      /The list covers the fields of roles, agents, task kinds, pipelines and stages\. It does not cover the manifest's `office\.name`, `project` model or `provenance`, and the order of roles, agents and task kinds is not compared\./u,
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

// GP-10B-1: the four development workflows in the reference pack, and
// expressible-subset parity for workflows with the legacy default pipelines.

const packWorkflows = [
  {
    id: "delivery",
    title: "Feature delivery",
    description: "Plan, implement, review, and verify product changes",
    taskType: "feature",
    stages: [
      { id: "design", role: "architect" },
      { id: "implement", role: "developer" },
      { id: "review", role: "reviewer" },
      { id: "verify", role: "qa" },
    ],
  },
  {
    id: "bugfix",
    title: "Bug fix",
    description: "Reproduce, fix, review, and verify a defect",
    taskType: "bugfix",
    stages: [
      { id: "reproduce", role: "qa" },
      { id: "fix", role: "developer" },
      { id: "review", role: "reviewer" },
    ],
  },
  {
    id: "discovery",
    title: "Research",
    description:
      "Investigate a question and record an evidence-based recommendation",
    taskType: "research",
    stages: [{ id: "investigate", role: "architect" }],
  },
  {
    id: "release",
    title: "Release",
    description:
      "Review readiness, verify the build, and require a release decision",
    taskType: "release",
    stages: [
      { id: "readiness", role: "reviewer" },
      { id: "verification", role: "qa" },
    ],
  },
];

/** The four routes the pack expresses, in task-type order. */
const packRoutes = [
  { taskType: "bugfix", workflow: "bugfix" },
  { taskType: "feature", workflow: "delivery" },
  { taskType: "release", workflow: "release" },
  { taskType: "research", workflow: "discovery" },
];

/** An office manifest as a test edits it. */
interface EditableOffice {
  office: { roles: { responsibilities: string[] }[] };
  pipelines: {
    id: string;
    name: string;
    description: string;
    enforcement?: string;
    defaultFor: string[];
    stages: {
      id: string;
      name: string;
      roleId: string;
      objective: string;
      checks: string[];
      requiresApproval: boolean;
      capabilities?: string[];
      requiresIndependentApproval?: boolean;
      requiresDifferentAgentFrom?: string[];
    }[];
  }[];
}

/**
 * The legacy profile of the GP-09 fixture office with one edit to its office
 * manifest, derived by the real derivation, so its digest moves with the edit.
 */
function legacyProfileWith(mutate: (office: EditableOffice) => void) {
  const input = legacyProfileInput();
  const manifest = structuredClone(input.office!.manifest);
  mutate(manifest as unknown as EditableOffice);
  return deriveLegacyDevelopmentProfile({
    ...input,
    office: { revision: input.office!.revision, manifest },
  });
}

const pipelineOf = (office: EditableOffice, id: string) =>
  office.pipelines.find((pipeline) => pipeline.id === id)!;

describe("GP-10B-1 development workflows in the reference pack", () => {
  test("version 0.2.0 declares exactly the four workflows, each with a title, a description, one task type and ordered stages", () => {
    const manifest = verifyDomainPackManifest(developmentPackBytes(), 1);
    expect(`${manifest.id}@${manifest.version}`).toBe(
      "org.ai-office.development@0.2.0",
    );
    expect(manifest.manifestDigest).toBe(
      "sha256:6321bb076a19765ce50f3127914c95487658c44e4cf480c3471337d2983f227e",
    );
    expect(manifest.contributions.workflows).toEqual(packWorkflows);
    // The raw file carries those keys and no other.
    const raw = JSON.parse(
      new TextDecoder().decode(developmentPackBytes()),
    ) as RawPackManifest;
    for (const workflow of raw.contributions.workflows!) {
      expect(Object.keys(workflow)).toEqual([
        "id",
        "title",
        "description",
        "taskType",
        "stages",
      ]);
      for (const stage of workflow.stages!)
        expect(Object.keys(stage)).toEqual(["id", "role"]);
    }
  });

  test("roles, agents, task types and capabilities are those of 0.1.0", () => {
    const { contributions } = verifyDomainPackManifest(developmentPackBytes());
    const unchanged = (source: typeof contributions) =>
      createHash("sha256")
        .update(
          JSON.stringify({
            roles: source.roles,
            agents: source.agents,
            taskTypes: source.taskTypes,
            capabilities: source.capabilities,
          }),
        )
        .digest("hex");
    // Computed from the committed 0.1.0 manifest before the workflows.
    const pinned =
      "45c8fb314eb56986aefcaaeeb4c90496ec9721f3dba5aa103bf7d23af49ec0e6";
    expect(unchanged(contributions)).toBe(pinned);
    // The pin sees a change to any of the four.
    expect(
      unchanged(
        verifyDomainPackManifest(
          mutatedDevelopmentPackBytes((copy) => {
            copy.contributions.roles![3]!.capabilities = [
              "derive_test_cases",
              "report_regressions",
            ];
          }),
        ).contributions,
      ),
    ).not.toBe(pinned);
  });

  test("every workflow names a task type and stage roles the pack declares, and every stage role has an agent", () => {
    const { contributions } = verifyDomainPackManifest(developmentPackBytes());
    const roles = contributions.roles.map((role) => role.id);
    const taskTypes = contributions.taskTypes.map((type) => type.id);
    for (const workflow of contributions.workflows) {
      expect(taskTypes).toContain(workflow.taskType);
      for (const stage of workflow.stages) {
        expect(roles).toContain(stage.role);
        expect(contributions.agents.map((agent) => agent.role)).toContain(
          stage.role,
        );
      }
    }
  });
});

describe("GP-10B-1 expressible-subset parity for workflows on the GP-09 fixture office", () => {
  const legacy = projectLegacyProfile(fixtureProfile);

  test("the resolved workflows equal the legacy pipelines on ID, name as title, description and the ordered stages by ID and role", () => {
    const resolved = resolvedSubset(developmentPackBytes());
    expect(resolved.workflows).toEqual(legacy.workflows);
    expect(resolved.routes).toEqual(legacy.routes);
    // What was compared, from the legacy side: not an empty shape.
    expect(legacy.workflows).toEqual(
      fixtureProfile.pipelines
        .map((pipeline) => ({
          id: pipeline.id,
          title: pipeline.name,
          description: pipeline.description,
          taskTypes: [pipeline.defaultFor[0]],
          stages: pipeline.stages.map((stage) => ({
            id: stage.id,
            role: stage.roleId,
          })),
        }))
        .sort((left, right) => (left.id < right.id ? -1 : 1)),
    );
    // And from the pack side, as literals.
    expect(resolved.workflows).toEqual(
      packWorkflows
        .map(({ taskType, ...workflow }) => ({
          ...workflow,
          taskTypes: [taskType],
        }))
        .sort((left, right) => (left.id < right.id ? -1 : 1)),
    );
    expect(resolved.workflows.map((workflow) => workflow.id)).toEqual([
      "bugfix",
      "delivery",
      "discovery",
      "release",
    ]);
  });

  test("every pack route is a legacy route, and the only legacy route missing is maintenance -> delivery", () => {
    const pack = resolvedSubset(developmentPackBytes()).routes;
    const all = legacyRoutes(fixtureProfile);
    expect(pack).toEqual(packRoutes);
    for (const route of pack) expect(all).toContainEqual(route);
    expect(
      all.filter(
        (route) =>
          !pack.some(
            (expressed) =>
              expressed.taskType === route.taskType &&
              expressed.workflow === route.workflow,
          ),
      ),
    ).toEqual([{ taskType: "maintenance", workflow: "delivery" }]);
    expect(unexpressedLegacyRoute).toEqual({
      taskType: "maintenance",
      workflow: "delivery",
    });
    expect(all).toHaveLength(5);
  });

  test.each<[string, (manifest: RawPackManifest) => void]>([
    [
      "a workflow title",
      (manifest) => {
        manifest.contributions.workflows![0]!.title = "Delivery";
      },
    ],
    [
      "a workflow description",
      (manifest) => {
        manifest.contributions.workflows![1]!.description += ".";
      },
    ],
    [
      "the stage order",
      (manifest) => {
        manifest.contributions.workflows![0]!.stages!.reverse();
      },
    ],
    [
      "a stage ID",
      (manifest) => {
        manifest.contributions.workflows![2]!.stages![0]!.id = "explore";
      },
    ],
    [
      "a stage role",
      (manifest) => {
        manifest.contributions.workflows![3]!.stages![1]!.role = "developer";
      },
    ],
    [
      "an expressed route",
      (manifest) => {
        manifest.contributions.workflows![0]!.taskType = "maintenance";
      },
    ],
    [
      "a workflow ID",
      (manifest) => {
        manifest.contributions.workflows![2]!.id = "research";
      },
    ],
    [
      "the set of workflows",
      (manifest) => {
        manifest.contributions.workflows!.pop();
      },
    ],
  ])("changing %s in a copy of the pack breaks parity", (_name, mutate) => {
    const resolved = resolvedSubset(mutatedDevelopmentPackBytes(mutate));
    expect({
      workflows: resolved.workflows,
      routes: resolved.routes,
    }).not.toEqual({ workflows: legacy.workflows, routes: legacy.routes });
    // The roles, agents and task types of the copy are still at parity, so
    // the difference is the workflow change.
    expect({ ...resolved, workflows: [], routes: [] }).toEqual({
      ...legacy,
      workflows: [],
      routes: [],
    });
  });

  test.each<[string, (office: EditableOffice) => void]>([
    [
      "a pipeline name",
      (office) => {
        pipelineOf(office, "bugfix").name = "Defect fix";
      },
    ],
    [
      "a pipeline description",
      (office) => {
        pipelineOf(office, "release").description += ".";
      },
    ],
    [
      "the stage order",
      (office) => {
        pipelineOf(office, "delivery").stages.reverse();
      },
    ],
    [
      "a stage ID",
      (office) => {
        pipelineOf(office, "discovery").stages[0]!.id = "explore";
      },
    ],
    [
      "a stage role",
      (office) => {
        pipelineOf(office, "delivery").stages[3]!.roleId = "reviewer";
      },
    ],
    [
      "an expressed route, moved to another pipeline",
      (office) => {
        pipelineOf(office, "delivery").defaultFor = ["maintenance"];
        pipelineOf(office, "bugfix").defaultFor = ["bugfix", "feature"];
      },
    ],
    [
      "two expressed routes, swapped",
      (office) => {
        pipelineOf(office, "discovery").defaultFor = ["release"];
        pipelineOf(office, "release").defaultFor = ["research"];
      },
    ],
  ])("changing %s in the legacy office breaks parity", (_name, mutate) => {
    const changed = legacyProfileWith(mutate);
    expect(changed.profileDigest).not.toBe(fixtureProfile.profileDigest);
    expect(resolvedSubset(developmentPackBytes())).not.toEqual(
      projectLegacyProfile(changed),
    );
  });

  test("the unedited legacy office, derived the same way, is at parity", () => {
    const same = legacyProfileWith(() => undefined);
    expect(same.profileDigest).toBe(fixtureProfile.profileDigest);
    expect(resolvedSubset(developmentPackBytes())).toEqual(
      projectLegacyProfile(same),
    );
  });

  test.each<[string, string, (office: EditableOffice) => void]>([
    [
      "a stage name",
      "stage.name",
      (office) => {
        pipelineOf(office, "delivery").stages[0]!.name = "Plan";
      },
    ],
    [
      "a stage objective",
      "stage.objective",
      (office) => {
        pipelineOf(office, "bugfix").stages[1]!.objective = "Fix it";
      },
    ],
    [
      "the stage checks",
      "stage.checks",
      (office) => {
        pipelineOf(office, "release").stages[1]!.checks.push("Signed off");
      },
    ],
    [
      "a stage approval requirement",
      "stage.requiresApproval",
      (office) => {
        pipelineOf(office, "delivery").stages[2]!.requiresApproval = false;
      },
    ],
    [
      "the stage capabilities",
      "stage.capabilities",
      (office) => {
        pipelineOf(office, "delivery").stages[1]!.capabilities = ["run_tests"];
      },
    ],
    [
      "a stage independent-approval requirement",
      "stage.requiresIndependentApproval",
      (office) => {
        pipelineOf(office, "delivery").stages[2]!.requiresIndependentApproval =
          true;
      },
    ],
    [
      "a stage separation constraint",
      "stage.requiresDifferentAgentFrom",
      (office) => {
        pipelineOf(office, "bugfix").stages[2]!.requiresDifferentAgentFrom = [
          "fix",
        ];
      },
    ],
    [
      "the pipeline enforcement",
      "pipeline.enforcement",
      (office) => {
        pipelineOf(office, "delivery").enforcement = "guidance";
      },
    ],
    [
      "the maintenance route, removed",
      "pipeline.defaultFor",
      (office) => {
        pipelineOf(office, "delivery").defaultFor = ["feature"];
      },
    ],
    [
      "the maintenance route, moved to another pipeline",
      "task_kind.pipelineId",
      (office) => {
        pipelineOf(office, "delivery").defaultFor = ["feature"];
        pipelineOf(office, "bugfix").defaultFor = ["bugfix", "maintenance"];
      },
    ],
    [
      "an office role responsibility",
      "office_role.responsibilities",
      (office) => {
        office.office.roles[0]!.responsibilities.push("Write the ADR");
      },
    ],
  ])(
    "changing %s, which schema 1 cannot represent, moves the legacy profile and leaves parity equal, and %s is in the residue list",
    (_name, key, mutate) => {
      const changed = legacyProfileWith(mutate);
      expect(changed.profileDigest).not.toBe(fixtureProfile.profileDigest);
      expect(projectLegacyProfile(changed)).toEqual(legacy);
      expect(resolvedSubset(developmentPackBytes())).toEqual(
        projectLegacyProfile(changed),
      );
      expect(outsidePackVocabulary().entries.map(entryKey)).toContain(key);
    },
  );
});

describe("GP-10B-1 residue list", () => {
  const routeText = (route: { taskType: string; workflow: string }) =>
    `${route.taskType} -> ${route.workflow}`;

  test("the 12 entries GP-10A assigned to GP-10B are all there, each with what GP-10B-1 delivers, what remains and the task that owns the residue", () => {
    const vocabulary = outsidePackVocabulary();
    expect(vocabulary.pack).toEqual({
      id: "org.ai-office.development",
      version: "0.2.0",
    });
    expect(vocabulary.owners["GP-10B-2"]).toContain(descriptiveExtensionTaskId);
    expect(vocabulary.owners["GP-25"]).toContain(policyTaskId);
    expect(vocabulary.owners["GP-25"]).toContain("provisional");
    const formerlyGp10b = vocabulary.entries.filter(
      (entry) => entry.owner === "GP-10B-2" || entry.owner === "GP-25",
    );
    expect(
      formerlyGp10b.map((entry) => [
        entryKey(entry),
        entry.owner,
        entry.delivered === null ? "nothing" : "part",
      ]),
    ).toEqual([
      ["office_role.responsibilities", "GP-10B-2", "nothing"],
      ["runtime_role.guidance", "GP-10B-2", "nothing"],
      ["task_kind.pipelineId", "GP-10B-2", "part"],
      ["pipeline.defaultFor", "GP-10B-2", "part"],
      ["pipeline.enforcement", "GP-25", "nothing"],
      ["stage.name", "GP-10B-2", "nothing"],
      ["stage.objective", "GP-10B-2", "nothing"],
      ["stage.checks", "GP-10B-2", "nothing"],
      ["stage.requiresApproval", "GP-25", "nothing"],
      ["stage.capabilities", "GP-25", "nothing"],
      ["stage.requiresIndependentApproval", "GP-25", "nothing"],
      ["stage.requiresDifferentAgentFrom", "GP-25", "nothing"],
    ]);
    expect(formerlyGp10b).toHaveLength(12);
    expect(vocabulary.entries).toHaveLength(19);
    // The five governance entries are the policy task's, and no other.
    expect(
      vocabulary.entries
        .filter((entry) => entry.owner === "GP-25")
        .map(entryKey)
        .sort(),
    ).toEqual([
      "pipeline.enforcement",
      "stage.capabilities",
      "stage.requiresApproval",
      "stage.requiresDifferentAgentFrom",
      "stage.requiresIndependentApproval",
    ]);
    // The entries GP-10B never owned deliver nothing and keep their owner.
    expect(
      vocabulary.entries
        .filter((entry) => !formerlyGp10b.includes(entry))
        .map((entry) => [entryKey(entry), entry.owner, entry.delivered]),
    ).toEqual([
      ["runtime_role.name", executionParityTaskId, null],
      ["runtime_role.version", executionParityTaskId, null],
      ["runtime_role.capabilities#order", executionParityTaskId, null],
      ["runtime_role.tools", "GP-10C", null],
      ["runtime_role.modelPolicy", executionParityTaskId, null],
      ["runtime_role.limits", executionParityTaskId, null],
      ["agent.enabled", executionParityTaskId, null],
    ]);
    for (const entry of vocabulary.entries)
      expect(entry.residue.length).toBeGreaterThan(0);
  });

  test("the task-kind pipelineId and pipeline defaultFor entries record the four expressed routes as delivered and maintenance -> delivery as residue", () => {
    const vocabulary = outsidePackVocabulary();
    const expressed = resolvedSubset(developmentPackBytes()).routes;
    expect(expressed).toHaveLength(4);
    for (const key of ["task_kind.pipelineId", "pipeline.defaultFor"]) {
      const entry = vocabulary.entries.find(
        (candidate) => entryKey(candidate) === key,
      )!;
      for (const route of expressed) {
        expect(entry.delivered).toContain(routeText(route));
        expect(entry.residue).not.toContain(routeText(route));
      }
      expect(entry.residue).toContain(routeText(unexpressedLegacyRoute));
      expect(entry.residue).toContain("maintenance -> delivery");
      expect(entry.delivered).not.toContain("maintenance");
      expect(entry.owner).toBe("GP-10B-2");
    }
  });

  test("a list without the delivered part or the residue of an entry is rejected", () => {
    const raw = JSON.parse(readFileSync(outsidePackVocabularyPath, "utf8")) as {
      entries: Record<string, unknown>[];
    };
    const { delivered: _delivered, ...undelivered } = raw.entries[0]!;
    expect(() =>
      parseOutsidePackVocabulary({ ...raw, entries: [undelivered] }),
    ).toThrow(/delivered must be a statement or null/u);
    const { residue: _residue, ...residueless } = raw.entries[0]!;
    expect(() =>
      parseOutsidePackVocabulary({ ...raw, entries: [residueless] }),
    ).toThrow(/missing residue/u);
    expect(() =>
      parseOutsidePackVocabulary({
        ...raw,
        entries: [{ ...raw.entries[0], owner: "GP-10B" }],
      }),
    ).toThrow(/missing or unknown owner/u);
    expect(() =>
      parseOutsidePackVocabulary({ ...raw, schemaVersion: 1 }),
    ).toThrow(/expected schemaVersion 2/u);
  });
});

describe("GP-10B-1 documentation", () => {
  const read = (path: string) =>
    readFileSync(join(repositoryRoot, path), "utf8");
  const plan = read("docs/development/generic-core-domain-packs.md");
  const start = plan.indexOf("\n## GP-10B-1 development workflow templates\n");
  const section = plan.slice(start, plan.indexOf("\n## ", start + 1));
  const oneLine = (text: string) =>
    text.replace(/\n>/gu, "\n").replace(/\s+/gu, " ");
  const prose = oneLine(section);
  const antiGoal =
    "the pack must not become authoritative for Runtime execution without a separately approved task";
  const row = (prefix: string) =>
    plan.split("\n").filter((line) => line.startsWith(prefix));

  test("the plan names the claim, repeats the anti-goal verbatim, and states that nothing was removed and that prompts were not delivered", () => {
    expect(start).toBeGreaterThan(0);
    expect(section).toMatch(
      /\n> the pack must not become authoritative for Runtime execution without a\n> separately approved task\n/u,
    );
    expect(prose).toContain(antiGoal);
    expect(prose).toContain("**expressible-subset parity for workflows**");
    expect(prose).toContain("it is not execution parity");
    expect(prose).toContain("It is not equality of the whole legacy pipeline");
    expect(prose).toContain(`(\`${executionParityTaskId}\`)`);
    expect(prose).toContain("Nothing was removed from the legacy path.");
    expect(prose).toContain("Prompts were not delivered");
    expect(prose).toContain(
      "No contract change, Runtime consumption, catalog registration, adoption or legacy-path removal occurs in GP-10B-1.",
    );
    expect(section).not.toMatch(/\bmov(?:ed|es|ing)\b/iu);
    expect(section).toContain("### Implementation record");
  });

  test("the plan records the owner decisions: the split, the policy task and the dependencies of execution parity", () => {
    expect(prose).toContain(descriptiveExtensionTaskId);
    expect(prose).toContain(policyTaskId);
    expect(prose).toContain("The number GP-25 is provisional");
    expect(prose).toContain(
      `The execution parity task \`${executionParityTaskId}\` depends on GP-10B-1, GP-10B-2 and the policy task (GP-25).`,
    );
    expect(prose).toContain(
      "The frozen GP-09 profile and its gap codes stay untouched.",
    );
    expect(row("| GP-10B — ")).toEqual([]);
    const [first, ...moreFirst] = row("| GP-10B-1 — ");
    expect(moreFirst).toEqual([]);
    expect(first).toContain("expressible-subset parity for workflows");
    expect(first).not.toMatch(/\bmov(?:e|ed|es|ing)\b|behind pack defaults/iu);
    const [second, ...moreSecond] = row("| GP-10B-2 — ");
    expect(moreSecond).toEqual([]);
    expect(second).toContain(descriptiveExtensionTaskId);
    const [policy, ...morePolicy] = row("| GP-25 — ");
    expect(morePolicy).toEqual([]);
    expect(policy).toContain("Pack policy contribution contract");
    expect(policy).toContain(policyTaskId);
    expect(policy).toContain("Provisional number");
    expect(policy).toContain("owner-approved scope proposal");
    expect(plan).toContain(
      "GP-10B-1 + GP-10B-2 + GP-25 → Runtime task a45ddb12 execution parity",
    );
    const stage = oneLine(
      plan.slice(
        plan.indexOf("4. **Extraction:**"),
        plan.indexOf("5. **Opt-in adoption:**"),
      ),
    );
    expect(stage).toContain(
      "GP-10B-1 delivers the second slice as expressible-subset parity over workflows and removes nothing",
    );
  });

  test("the plan's workflow table is the committed manifest", () => {
    const { contributions } = verifyDomainPackManifest(developmentPackBytes());
    expect(tableRows(section, 4)).toEqual(
      contributions.workflows.map((workflow) => [
        `\`${workflow.id}\``,
        workflow.title,
        `\`${workflow.taskType}\``,
        workflow.stages
          .map((stage) => `\`${stage.id}\` (${stage.role})`)
          .join(", "),
      ]),
    );
  });

  test("the plan's residue table is the committed list, entry for entry", () => {
    const rows = tableRows(section, 6);
    expect(rows).toEqual(
      outsidePackVocabulary().entries.map((entry) => [
        subjectLabels[entry.subject],
        fieldLabel(entry),
        entry.delivered ?? "nothing",
        entry.residue,
        entry.owner === executionParityTaskId ? "a45ddb12" : entry.owner,
        entry.gp09Gap === null
          ? expect.stringMatching(/^none/u)
          : entry.inDefaultState
            ? `\`${entry.gp09Gap}\``
            : `\`${entry.gp09Gap}\` if used; unused by the defaults`,
      ]),
    );
    expect(rows).toHaveLength(19);
    expect(rows.filter((cells) => cells[2] !== "nothing")).toHaveLength(2);
  });

  test("the pack README, the roadmap and the architecture overview say the same and claim nothing more", () => {
    const readme = oneLine(read("packages/domain-pack-development/README.md"));
    expect(readme).toContain("`org.ai-office.development@0.2.0`");
    expect(readme).toContain(antiGoal);
    expect(readme).toContain("nothing was removed from the legacy path");
    expect(readme).toContain("Prompts were not delivered");
    expect(readme).toContain(executionParityTaskId);
    expect(readme).toContain("it is not execution parity");
    const roadmap = oneLine(read("docs/development/roadmap.md"));
    expect(roadmap).toMatch(
      /GP-10B-1 extends the pack to `0\.2\.0` .*? expressible-subset parity for workflows.*? It is not execution parity/u,
    );
    expect(roadmap).toContain(antiGoal);
    expect(roadmap).toContain("Prompts were not delivered");
    const overview = oneLine(read("docs/architecture/overview.md"));
    expect(overview).toMatch(
      /GP-10B-1 adds the four development workflows to that manifest.*?nothing is scheduled from/u,
    );
  });
});
