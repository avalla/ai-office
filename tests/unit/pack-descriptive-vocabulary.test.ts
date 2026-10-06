import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  computeArtifactDigest,
  computeManifestDigest,
  contributionKinds,
  maximumContributionReferences,
  maximumDescriptiveListEntries,
  parseDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import type { ProjectPackBinding } from "../../packages/application/src/ports/project-pack-binding-repository.port.ts";
import {
  ProjectDefinitionConflictError,
  maximumDefinitionTextLength,
  parseDefinitionMutation,
  type ProjectDefinitionState,
} from "../../packages/application/src/domain-pack/project-definition.ts";
import {
  ProjectConfigurationResolutionError,
  resolveProjectConfiguration,
} from "../../packages/application/src/domain-pack/resolve-project-configuration.ts";
import { InMemoryInstalledDomainPackCatalog } from "../../packages/runtime-host/src/installed-domain-pack-catalog.ts";

// GP-10B-2, PR 1: the descriptive vocabulary in the project mutation contract
// and in the resolved configuration.

type Tuple = ProjectPackBinding["packs"][number];
type Override = ProjectDefinitionState["overrides"][number];
type Owned = ProjectDefinitionState["owned"][number];

const encoder = new TextEncoder();
const catalog = () =>
  new InMemoryInstalledDomainPackCatalog(1, ["local-distribution"]);
type Catalog = ReturnType<typeof catalog>;

function packBytes(
  version: string,
  contributions: Record<string, unknown[]>,
  id = "org.example.legal",
): Uint8Array {
  const draft = {
    schemaVersion: 1,
    id,
    version,
    manifestDigest: `sha256:${"0".repeat(64)}`,
    coreContract: { minInclusive: 1, maxExclusive: 3 },
    metadata: { name: "Legal", description: "Descriptive fixture" },
    dependencies: [],
    contributions: {
      ...Object.fromEntries(contributionKinds.map((kind) => [kind, []])),
      ...contributions,
    },
  };
  return encoder.encode(
    JSON.stringify({
      ...draft,
      manifestDigest: computeManifestDigest(
        parseDomainPackManifest(encoder.encode(JSON.stringify(draft))),
      ),
    }),
  );
}

function register(target: Catalog, bytes: Uint8Array): Tuple {
  return target.register({
    bytes,
    artifactDigest: computeArtifactDigest(bytes),
    provenance: { installerId: "local-distribution", reference: "fixture" },
  });
}

const counsel = {
  id: "counsel",
  title: "Counsel",
  capabilities: ["sign"],
  responsibilities: ["Advise the client", "Sign filings"],
};
const review = {
  id: "review",
  title: "Review",
  taskType: "matter",
  additionalTaskTypes: ["appeal", "filing"],
  stages: [
    {
      id: "draft",
      role: "clerk",
      title: "Draft",
      objective: "Produce the first draft",
      checks: ["Template used", "Facts cited"],
    },
    { id: "check", role: "counsel" },
  ],
};
const described = {
  roles: [counsel, { id: "clerk" }] as (typeof counsel)[],
  taskTypes: [{ id: "matter" }, { id: "filing" }, { id: "appeal" }],
  capabilities: [{ id: "sign" }],
  prompts: [{ id: "brief", title: "Brief", text: "Write the brief." }],
  workflows: [review],
};
const describedBytes = packBytes("1.0.0", described);

function state(
  owned: readonly Owned[] = [],
  overrides: readonly Override[] = [],
): ProjectDefinitionState {
  return {
    projectId: "project-a",
    revision: owned.length + overrides.length,
    owned,
    overrides,
  };
}

function resolve(
  target: Catalog,
  packs: readonly Tuple[],
  definitions = state(),
) {
  return resolveProjectConfiguration({
    projectId: "project-a",
    binding: { projectId: "project-a", configurationRevision: 1, packs },
    definitions,
    catalog: target,
    coreContractVersion: 1,
  });
}

function errorCode(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectConfigurationResolutionError);
    return (error as ProjectConfigurationResolutionError).code;
  }
  throw new Error("Expected resolution failure");
}

/** The code and message of a refused mutation, or "accepted". */
function refusal(mutation: unknown): { code: string; message: string } {
  try {
    parseDefinitionMutation(mutation);
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectDefinitionConflictError);
    const { code, message } = error as ProjectDefinitionConflictError;
    return { code, message };
  }
  return { code: "accepted", message: "" };
}
const mutationCode = (mutation: unknown): string => refusal(mutation).code;

const override = (
  pack: Tuple,
  localId: string,
  operation: Override["operation"],
  payload?: object,
  kind: Override["source"]["kind"] = "workflows",
): Override => ({
  origin: "project_override",
  source: { ...pack, kind, localId },
  operation,
  revision: 1,
  ...(payload === undefined
    ? {}
    : { payload: payload as NonNullable<Override["payload"]> }),
  actorId: "operator",
  changedAt: "2026-10-06T00:00:00.000Z",
});

const owned = (
  kind: Owned["kind"],
  id: string,
  payload: object = { id },
  enabled = true,
): Owned => ({
  origin: "project_owned",
  kind,
  id,
  revision: 1,
  enabled,
  payload: payload as Owned["payload"],
  actorId: "operator",
  changedAt: "2026-10-06T00:00:00.000Z",
});

const tuple = {
  id: "org.example.legal",
  version: "1.0.0",
  manifestDigest: `sha256:${"a".repeat(64)}`,
};
const putOwned = (kind: string, payload: object, id = "custom") => ({
  action: "put_owned",
  kind,
  id,
  enabled: true,
  payload,
});
const putOverride = (
  kind: string,
  operation: string,
  payload?: object,
  localId = "custom",
) => ({
  action: "put_override",
  source: { ...tuple, kind, localId },
  operation,
  ...(payload === undefined ? {} : { payload }),
});
/** The same payload as a project-owned definition and as a replacement. */
const both = (kind: string, payload: object) => [
  putOwned(kind, payload),
  putOverride(kind, "replace", payload),
];
const workflow = (extra: object = {}, stage: object = {}) => ({
  id: "custom",
  taskType: "matter",
  stages: [{ id: "check", role: "counsel", ...stage }],
  ...extra,
});
const loneSurrogate = "a\ud800b";
const tooLong = "x".repeat(maximumDefinitionTextLength + 1);
const atBound = "x".repeat(maximumDefinitionTextLength);
const many = (count: number) =>
  Array.from({ length: count }, (_, index) => `entry ${index}`);

describe("GP-10B-2 descriptive vocabulary in the mutation contract", () => {
  test("put_owned and replace accept the new keys of their kind and keep list order", () => {
    const responsibilities = [
      "Sign filings",
      "Advise the client",
      "Sign filings",
    ];
    for (const mutation of both("roles", {
      id: "custom",
      title: "Custom",
      responsibilities,
    })) {
      const parsed = parseDefinitionMutation(mutation);
      expect("payload" in parsed && parsed.payload).toEqual({
        id: "custom",
        title: "Custom",
        responsibilities,
      });
    }
    for (const mutation of both("prompts", {
      id: "custom",
      description: "House style",
      text: `Line one\nLine two ${atBound.slice(0, 100)}`,
    })) {
      const parsed = parseDefinitionMutation(mutation);
      expect("payload" in parsed && parsed.payload).toEqual({
        id: "custom",
        description: "House style",
        text: `Line one\nLine two ${atBound.slice(0, 100)}`,
      });
    }
    const envelope = {
      id: "custom",
      title: "Custom",
      taskType: "matter",
      additionalTaskTypes: ["filing", "appeal", "Zeta"],
      stages: [
        {
          id: "z-last",
          role: "counsel",
          title: "Last",
          objective: "Close the matter",
          checks: ["b", "a", "b"],
        },
        { id: "a-first", role: "clerk", objective: atBound },
        { id: "m-middle", role: "clerk", checks: many(64) },
      ],
    };
    for (const mutation of both("workflows", envelope)) {
      const parsed = parseDefinitionMutation(mutation);
      expect("payload" in parsed && parsed.payload).toEqual({
        ...envelope,
        // A set: stored in ascending code-unit order.
        additionalTaskTypes: ["Zeta", "appeal", "filing"],
      });
    }
    // The bounds are inclusive.
    expect(
      mutationCode(
        putOwned("roles", { id: "custom", responsibilities: many(64) }),
      ),
    ).toBe("accepted");
    expect(
      mutationCode(putOwned("prompts", { id: "custom", text: atBound })),
    ).toBe("accepted");
    expect(maximumDescriptiveListEntries).toBe(64);
  });

  test("malformed text and lists are refused as malformed_origin_reference", () => {
    const refused: object[] = [];
    for (const text of [
      "",
      tooLong,
      "a\u0000b",
      loneSurrogate,
      1,
      null,
      ["x"],
    ]) {
      refused.push(...both("prompts", { id: "custom", text }));
      refused.push(...both("workflows", workflow({}, { title: text })));
      refused.push(...both("workflows", workflow({}, { objective: text })));
      refused.push(
        ...both("workflows", workflow({}, { checks: ["fine", text] })),
      );
      refused.push(
        ...both("roles", { id: "custom", responsibilities: ["fine", text] }),
      );
    }
    for (const list of [[], many(65), "one", { 0: "one" }, null]) {
      refused.push(...both("roles", { id: "custom", responsibilities: list }));
      refused.push(...both("workflows", workflow({}, { checks: list })));
    }
    for (const list of [
      [],
      "filing",
      null,
      ["no id"],
      [""],
      [1],
      Array.from(
        { length: maximumContributionReferences + 1 },
        (_, index) => `t${index}`,
      ),
    ])
      refused.push(
        ...both("workflows", workflow({ additionalTaskTypes: list })),
      );
    // An unknown stage key keeps the GP-13 code.
    for (const key of ["responsibilities", "text", "description", "name"])
      refused.push(...both("workflows", workflow({}, { [key]: "x" })));
    for (const mutation of refused) {
      const { code, message } = refusal(mutation);
      expect(code, JSON.stringify(mutation).slice(0, 200)).toBe(
        "malformed_origin_reference",
      );
      // A message names the field and never quotes a value.
      expect(message).not.toContain("fine");
      expect(message.length).toBeLessThan(200);
    }
  });

  test("a duplicate additional task type, or one equal to the task type, is refused", () => {
    for (const additionalTaskTypes of [
      ["filing", "filing"],
      ["matter"],
      ["filing", "matter"],
    ])
      for (const mutation of both(
        "workflows",
        workflow({ additionalTaskTypes }),
      ))
        expect(mutationCode(mutation)).toBe("conflicting_ownership_metadata");
  });

  test("a new key on the wrong kind or in an extend is refused as protected_security_invariant", () => {
    const fields: Record<string, unknown> = {
      responsibilities: ["One"],
      text: "Text",
      additionalTaskTypes: ["filing"],
      objective: "Why",
      checks: ["One"],
    };
    const home: Record<string, string> = {
      responsibilities: "roles",
      text: "prompts",
      additionalTaskTypes: "workflows",
    };
    for (const kind of [
      "roles",
      "taskTypes",
      "agents",
      "artifactTypes",
      "evidenceTypes",
      "knowledge",
      "prompts",
      "workflows",
    ])
      for (const [field, value] of Object.entries(fields)) {
        if (home[field] === kind) continue;
        const payload =
          kind === "workflows"
            ? workflow({ [field]: value })
            : { id: "custom", [field]: value };
        for (const mutation of both(kind, payload))
          expect(mutationCode(mutation), `${kind}.${field}`).toBe(
            "protected_security_invariant",
          );
      }
    // An extension stays descriptive for every kind.
    for (const kind of ["roles", "prompts", "workflows", "agents"])
      for (const [field, value] of Object.entries(fields)) {
        expect(
          mutationCode(putOverride(kind, "extend", { [field]: value })),
          `${kind}.${field}`,
        ).toBe("protected_security_invariant");
        expect(
          mutationCode(
            putOverride(kind, "extend", { title: "Ours", [field]: value }),
          ),
          `${kind}.${field}`,
        ).toBe("protected_security_invariant");
      }
    expect(
      mutationCode(putOverride("workflows", "extend", { stages: [] })),
    ).toBe("protected_security_invariant");
    // A disable carries no payload.
    for (const kind of ["roles", "prompts", "workflows"])
      expect(
        mutationCode(putOverride(kind, "disable", { id: "custom", text: "x" })),
      ).toBe("malformed_origin_reference");
  });

  test("a role payload still cannot carry capabilities", () => {
    for (const mutation of both("roles", {
      id: "custom",
      responsibilities: ["One"],
      capabilities: ["sign"],
    }))
      expect(mutationCode(mutation)).toBe("protected_security_invariant");
    expect(
      mutationCode(putOverride("roles", "extend", { capabilities: ["sign"] })),
    ).toBe("protected_security_invariant");
  });
});

describe("GP-10B-2 descriptive vocabulary in the resolved configuration", () => {
  test("the view reports responsibilities, stage fields and additional task types of a pack", () => {
    const target = catalog();
    const pack = register(target, describedBytes);
    const result = resolve(target, [pack]);
    const stable = (kind: string, id: string) =>
      `pack:org.example.legal/${kind}/${id}`;
    const effective = (kind: string, id: string) =>
      `pack:org.example.legal@1.0.0#${pack.manifestDigest}/${kind}/${id}`;
    expect(result.roles).toEqual([
      {
        roleId: stable("roles", "clerk"),
        effectiveId: effective("roles", "clerk"),
        origin: "pack_owned",
        capabilities: [],
        customization: "none",
      },
      {
        roleId: stable("roles", "counsel"),
        effectiveId: effective("roles", "counsel"),
        origin: "pack_owned",
        title: "Counsel",
        responsibilities: ["Advise the client", "Sign filings"],
        capabilities: [stable("capabilities", "sign")],
        customization: "none",
      },
    ]);
    expect(result.workflows).toEqual([
      {
        workflowId: stable("workflows", "review"),
        effectiveId: effective("workflows", "review"),
        origin: "pack_owned",
        title: "Review",
        taskTypeId: stable("taskTypes", "matter"),
        additionalTaskTypeIds: [
          stable("taskTypes", "appeal"),
          stable("taskTypes", "filing"),
        ],
        stages: [
          {
            id: "draft",
            roleId: stable("roles", "clerk"),
            title: "Draft",
            objective: "Produce the first draft",
            checks: ["Template used", "Facts cited"],
          },
          { id: "check", roleId: stable("roles", "counsel") },
        ],
        customization: "none",
      },
    ]);
    // Digest material: the effective references, only for a routed workflow.
    expect(result.resolvedWorkflowReferences).toEqual([
      {
        workflowId: effective("workflows", "review"),
        taskTypeId: effective("taskTypes", "matter"),
        additionalTaskTypeIds: [
          effective("taskTypes", "appeal"),
          effective("taskTypes", "filing"),
        ],
        stages: [
          { id: "draft", roleId: effective("roles", "clerk") },
          { id: "check", roleId: effective("roles", "counsel") },
        ],
      },
    ]);
    // A prompt's text is in the effective definitions; there is no prompt view.
    expect(result.effectiveDefinitions.prompts).toEqual([
      {
        effectiveId: effective("prompts", "brief"),
        kind: "prompts",
        localId: "brief",
        enabled: true,
        payload: { id: "brief", title: "Brief", text: "Write the brief." },
      },
    ]);
  });

  test("a replacement is the complete envelope: an omitted field is absent, the capability set stays the pack's", () => {
    const target = catalog();
    const pack = register(target, describedBytes);
    const result = resolve(
      target,
      [pack],
      state(
        [],
        [
          override(pack, "brief", "replace", { id: "brief" }, "prompts"),
          override(
            pack,
            "counsel",
            "replace",
            { id: "counsel", title: "Our counsel" },
            "roles",
          ),
          override(pack, "review", "replace", {
            id: "review",
            taskType: "filing",
            stages: [{ id: "check", role: "counsel", checks: ["Ours"] }],
          }),
        ],
      ),
    );
    const role = result.roles.find((item) => item.title === "Our counsel");
    expect(role).toMatchObject({
      customization: "replace",
      capabilities: ["pack:org.example.legal/capabilities/sign"],
    });
    expect(Object.hasOwn(role!, "responsibilities")).toBe(false);
    expect(result.effectiveDefinitions.roles[1]?.payload).toEqual({
      id: "counsel",
      title: "Our counsel",
      capabilities: ["sign"],
    });
    expect(result.effectiveDefinitions.prompts[0]?.payload).toEqual({
      id: "brief",
    });
    const flow = result.workflows[0]!;
    expect(Object.hasOwn(flow, "additionalTaskTypeIds")).toBe(false);
    expect(flow.stages).toEqual([
      {
        id: "check",
        roleId: "pack:org.example.legal/roles/counsel",
        checks: ["Ours"],
      },
    ]);
    expect(
      Object.hasOwn(
        result.resolvedWorkflowReferences[0]!,
        "additionalTaskTypeIds",
      ),
    ).toBe(false);

    // A replacement that sets the fields replaces the pack's values.
    const replaced = resolve(
      target,
      [pack],
      state(
        [],
        [
          override(
            pack,
            "brief",
            "replace",
            { id: "brief", text: "Our brief." },
            "prompts",
          ),
          override(
            pack,
            "counsel",
            "replace",
            { id: "counsel", responsibilities: ["Ours first", "Advise"] },
            "roles",
          ),
          override(pack, "review", "replace", {
            id: "review",
            taskType: "filing",
            // Stored order is re-established by the resolver.
            additionalTaskTypes: ["matter", "appeal"],
            stages: [],
          }),
        ],
      ),
    );
    expect(replaced.effectiveDefinitions.prompts[0]?.payload).toEqual({
      id: "brief",
      text: "Our brief.",
    });
    expect(replaced.roles[1]).toMatchObject({
      responsibilities: ["Ours first", "Advise"],
      capabilities: ["pack:org.example.legal/capabilities/sign"],
    });
    expect(replaced.workflows[0]).toMatchObject({
      taskTypeId: "pack:org.example.legal/taskTypes/filing",
      additionalTaskTypeIds: [
        "pack:org.example.legal/taskTypes/appeal",
        "pack:org.example.legal/taskTypes/matter",
      ],
    });
  });

  test("an extension keeps every descriptive field of the pack", () => {
    const target = catalog();
    const pack = register(target, describedBytes);
    const plain = resolve(target, [pack]);
    const extended = resolve(
      target,
      [pack],
      state(
        [],
        [
          override(pack, "brief", "extend", { description: "Ours" }, "prompts"),
          override(pack, "counsel", "extend", { description: "Ours" }, "roles"),
          override(pack, "review", "extend", { description: "Ours" }),
        ],
      ),
    );
    expect(extended.roles[1]).toEqual({
      ...plain.roles[1],
      description: "Ours",
      customization: "extend",
    });
    expect(extended.workflows[0]).toEqual({
      ...plain.workflows[0],
      description: "Ours",
      customization: "extend",
    });
    expect(extended.effectiveDefinitions.prompts[0]?.payload).toEqual({
      id: "brief",
      title: "Brief",
      description: "Ours",
      text: "Write the brief.",
    });
  });

  test("a project-owned role, prompt and workflow carry the fields in the project namespace", () => {
    const target = catalog();
    const result = resolve(
      target,
      [],
      state([
        owned("prompts", "house", { id: "house", text: "House rules." }),
        owned("roles", "liaison", {
          id: "liaison",
          responsibilities: ["Call", "Write", "Call"],
        }),
        owned("taskTypes", "errand"),
        owned("taskTypes", "visit"),
        owned("workflows", "ours", {
          id: "ours",
          taskType: "errand",
          additionalTaskTypes: ["visit"],
          stages: [
            {
              id: "go",
              role: "liaison",
              title: "Go",
              checks: ["Back by noon"],
            },
          ],
        }),
      ]),
    );
    expect(result.roles).toEqual([
      {
        roleId: "project:roles/liaison",
        effectiveId: "project:roles/liaison",
        origin: "project_owned",
        responsibilities: ["Call", "Write", "Call"],
        capabilities: [],
        customization: "none",
      },
    ]);
    expect(result.workflows).toEqual([
      {
        workflowId: "project:workflows/ours",
        effectiveId: "project:workflows/ours",
        origin: "project_owned",
        taskTypeId: "project:taskTypes/errand",
        additionalTaskTypeIds: ["project:taskTypes/visit"],
        stages: [
          {
            id: "go",
            roleId: "project:roles/liaison",
            title: "Go",
            checks: ["Back by noon"],
          },
        ],
        customization: "none",
      },
    ]);
    expect(result.effectiveDefinitions.prompts[0]?.payload).toEqual({
      id: "house",
      text: "House rules.",
    });
  });

  test("a missing, ambiguous or disabled additional task type fails closed with the GP-06 code", () => {
    const target = catalog();
    const pack = register(target, describedBytes);
    // A replacement that arrived without the pre-store check names a task
    // type its pack does not declare.
    const replace = (additionalTaskTypes: string[]) =>
      override(pack, "review", "replace", {
        id: "review",
        taskType: "matter",
        additionalTaskTypes,
        stages: [],
      });
    expect(
      errorCode(() => resolve(target, [pack], state([], [replace(["ghost"])]))),
    ).toBe("missing_workflow_reference");
    // A project-owned task type is outside the pack namespace.
    expect(
      errorCode(() =>
        resolve(
          target,
          [pack],
          state([owned("taskTypes", "errand")], [replace(["errand"])]),
        ),
      ),
    ).toBe("missing_workflow_reference");

    // Project-owned workflows resolve project task types only.
    const flow = (additionalTaskTypes: string[], enabled = true) =>
      owned(
        "workflows",
        "ours",
        { id: "ours", taskType: "errand", additionalTaskTypes, stages: [] },
        enabled,
      );
    const project = (entries: Owned[], packs: Tuple[] = [pack]) =>
      errorCode(() => resolve(target, packs, state(entries)));
    expect(project([flow(["visit"]), owned("taskTypes", "errand")])).toBe(
      "missing_workflow_reference",
    );
    // A pack task type is outside the project namespace.
    expect(project([flow(["filing"]), owned("taskTypes", "errand")])).toBe(
      "missing_workflow_reference",
    );
    expect(
      project([
        flow(["visit"]),
        owned("taskTypes", "errand"),
        owned("taskTypes", "visit", { id: "visit" }, false),
      ]),
    ).toBe("disabled_required_definition");
    // A bare ID two other namespaces declare is ambiguous.
    const other = register(
      target,
      packBytes(
        "1.0.0",
        { taskTypes: [{ id: "filing" }] },
        "org.example.other",
      ),
    );
    expect(
      project([flow(["filing"]), owned("taskTypes", "errand")], [pack, other]),
    ).toBe("ambiguous_reference");

    // A disabled workflow's routes are not resolved.
    expect(
      resolve(
        target,
        [pack],
        state([flow(["visit"], false), owned("taskTypes", "errand")]),
      ).disabledWorkflows,
    ).toEqual(["project:workflows/ours"]);
    expect(
      resolve(
        target,
        [pack],
        state(
          [],
          [
            override(pack, "review", "disable"),
            // Its replacement would not resolve; it is not consulted.
          ],
        ),
      ).workflows,
    ).toEqual([]);
  });

  test("stored state that violates the contract fails closed", () => {
    const target = catalog();
    const pack = register(target, describedBytes);
    for (const entry of [
      override(
        pack,
        "counsel",
        "replace",
        { id: "counsel", text: "x" },
        "roles",
      ),
      override(pack, "counsel", "extend", { responsibilities: ["x"] }, "roles"),
      override(pack, "brief", "replace", { id: "brief", text: "" }, "prompts"),
      override(pack, "review", "replace", {
        id: "review",
        taskType: "matter",
        additionalTaskTypes: ["matter"],
        stages: [],
      }),
      override(pack, "review", "replace", {
        id: "review",
        taskType: "matter",
        stages: [{ id: "check", role: "counsel", checks: [] }],
      }),
    ])
      expect(
        errorCode(() => resolve(target, [pack], state([], [entry]))),
        JSON.stringify(entry.payload),
      ).toBe("unresolved_override");
    for (const entry of [
      owned("roles", "liaison", { id: "liaison", responsibilities: [] }),
      owned("prompts", "house", { id: "house", text: "a\u0000b" }),
      owned("taskTypes", "errand", { id: "errand", text: "x" }),
    ])
      expect(
        errorCode(() => resolve(target, [pack], state([entry]))),
        JSON.stringify(entry.payload),
      ).toBe("configuration_invariant");
  });

  test("every new field is digest material, and a configuration without them keeps its digest", () => {
    const digestOf = (contributions: Record<string, unknown[]>) => {
      const target = catalog();
      const pack = register(target, packBytes("1.0.0", contributions));
      return resolve(target, [pack]).configurationDigest;
    };
    const full = digestOf(described);
    const without = (edit: (copy: typeof described) => void) => {
      const copy = structuredClone(described);
      edit(copy);
      return digestOf(copy);
    };
    for (const digest of [
      without((copy) => copy.roles[0]!.responsibilities.reverse()),
      without((copy) => (copy.prompts[0]!.text = "Other.")),
      without((copy) => (copy.workflows[0]!.additionalTaskTypes = ["appeal"])),
      without((copy) => (copy.workflows[0]!.stages[0]!.title = "Other")),
      without((copy) => (copy.workflows[0]!.stages[0]!.objective = "Other")),
      without((copy) => copy.workflows[0]!.stages[0]!.checks!.reverse()),
    ])
      expect(digest).not.toBe(full);

    // The documented empty-input vector.
    expect(
      resolveProjectConfiguration({
        projectId: "runtime-local-a",
        binding: {
          projectId: "runtime-local-a",
          configurationRevision: 0,
          packs: [],
        },
        definitions: {
          projectId: "runtime-local-a",
          revision: 0,
          owned: [],
          overrides: [],
        },
        catalog: catalog(),
        coreContractVersion: 1,
      }).configurationDigest,
    ).toBe(
      "sha256:c272fa286a92c8d3732e97fec7b0373c3a7854cb70e4a108a7690acb92bd7b19",
    );

    // A configuration that uses none of the fields, on existing fixtures: the
    // legal golden fixture and development pack 0.2.0, with project-owned
    // definitions and two replacements. The digest was computed before the
    // extension existed.
    const target = catalog();
    const fixture = (path: string) =>
      register(target, readFileSync(new URL(path, import.meta.url)));
    const legal = fixture("../fixtures/domain-pack/legal.json");
    const development = fixture(
      "../../packages/domain-pack-development/manifest.json",
    );
    const pinned = resolveProjectConfiguration({
      projectId: "project-a",
      binding: {
        projectId: "project-a",
        configurationRevision: 1,
        packs: [legal, development],
      },
      definitions: {
        projectId: "project-a",
        revision: 3,
        owned: [
          owned("taskTypes", "errand"),
          owned("roles", "liaison", { id: "liaison", title: "Liaison" }),
          owned("workflows", "house", {
            id: "house",
            taskType: "errand",
            stages: [{ id: "only", role: "liaison" }],
          }),
        ],
        overrides: [
          override(development, "bugfix", "replace", {
            id: "bugfix",
            title: "Our bug fix",
            taskType: "bugfix",
            stages: [{ id: "fix", role: "developer" }],
          }),
          override(
            development,
            "reviewer",
            "replace",
            { id: "reviewer", title: "Our reviewer" },
            "roles",
          ),
        ],
      },
      catalog: target,
      coreContractVersion: 1,
    });
    expect(pinned.configurationDigest).toBe(
      "sha256:3db5032a1099aa19a2872eb8595d62fc43a2bcc7aa91ea08831b73d9cfff03a6",
    );
    const text = JSON.stringify(pinned);
    for (const field of [
      "additionalTaskTypeIds",
      "responsibilities",
      "objective",
      "checks",
    ])
      expect(text).not.toContain(`"${field}"`);
  });
});
