import { describe, expect, test } from "vitest";
import {
  computeArtifactDigest,
  computeManifestDigest,
  contributionKinds,
  parseDomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import type { ProjectPackBinding } from "../../packages/application/src/ports/project-pack-binding-repository.port.ts";
import {
  ProjectDefinitionConflictError,
  maximumWorkflowStages,
  parseDefinitionMutation,
  type ProjectDefinitionState,
} from "../../packages/application/src/domain-pack/project-definition.ts";
import {
  ProjectConfigurationResolutionError,
  resolveProjectConfiguration,
} from "../../packages/application/src/domain-pack/resolve-project-configuration.ts";
import { InMemoryInstalledDomainPackCatalog } from "../../packages/runtime-host/src/installed-domain-pack-catalog.ts";

type Tuple = ProjectPackBinding["packs"][number];
type Override = ProjectDefinitionState["overrides"][number];
type Owned = ProjectDefinitionState["owned"][number];

const encoder = new TextEncoder();
const catalog = () =>
  new InMemoryInstalledDomainPackCatalog(1, ["local-distribution"]);
type Catalog = ReturnType<typeof catalog>;

/** Exact bytes of one schema-1 manifest with a computed digest. */
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
    metadata: { name: "Legal", description: "Workflow template fixture" },
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

const shared = {
  roles: [
    { id: "counsel", title: "Counsel" },
    { id: "clerk" },
    { id: "paralegal" },
    { id: "auditor" },
  ],
  taskTypes: [{ id: "matter", title: "Matter" }, { id: "filing" }],
};
// `clerk` is used by `intake` only, and `auditor` by `audit` only.
const intake = {
  id: "intake",
  taskType: "filing",
  stages: [{ id: "file", role: "clerk" }],
};
const audit = {
  id: "audit",
  taskType: "matter",
  stages: [{ id: "inspect", role: "auditor" }],
};
const v1 = packBytes("1.0.0", {
  ...shared,
  workflows: [
    {
      id: "review",
      title: "Review",
      taskType: "matter",
      stages: [
        { id: "draft", role: "paralegal" },
        { id: "check", role: "counsel" },
      ],
    },
    intake,
    audit,
  ],
});
// A later version: the review is renamed and gains a stage.
const v2 = packBytes("2.0.0", {
  ...shared,
  workflows: [
    {
      id: "review",
      title: "Matter review",
      taskType: "matter",
      stages: [
        { id: "draft", role: "paralegal" },
        { id: "check", role: "counsel" },
        { id: "sign", role: "counsel" },
      ],
    },
    intake,
    audit,
  ],
});

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

function mutationCode(mutation: unknown): string {
  try {
    parseDefinitionMutation(mutation);
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectDefinitionConflictError);
    return (error as ProjectDefinitionConflictError).code;
  }
  return "accepted";
}

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

type Resolved = ReturnType<typeof resolve>;
const workflow = (result: Resolved, workflowId: string) =>
  result.workflows.find((item) => item.workflowId === workflowId);
const pid = (kind: string, localId: string, pack = "org.example.legal") =>
  `pack:${pack}/${kind}/${localId}`;
const stage = (id: string, role: string) => ({
  id,
  roleId: role.includes(":") ? role : pid("roles", role),
});

describe("GP-13 workflow contract view", () => {
  test("pack workflows resolve with stable identities, their task type and their ordered stage roles", () => {
    const target = catalog();
    const pack = register(target, v1);
    const result = resolve(target, [pack]);
    const effective = (localId: string) =>
      `pack:org.example.legal@1.0.0#${pack.manifestDigest}/workflows/${localId}`;
    expect(result.workflows).toEqual([
      {
        workflowId: pid("workflows", "audit"),
        effectiveId: effective("audit"),
        origin: "pack_owned",
        taskTypeId: pid("taskTypes", "matter"),
        stages: [stage("inspect", "auditor")],
        customization: "none",
      },
      {
        workflowId: pid("workflows", "intake"),
        effectiveId: effective("intake"),
        origin: "pack_owned",
        taskTypeId: pid("taskTypes", "filing"),
        stages: [stage("file", "clerk")],
        customization: "none",
      },
      {
        workflowId: pid("workflows", "review"),
        effectiveId: effective("review"),
        origin: "pack_owned",
        title: "Review",
        taskTypeId: pid("taskTypes", "matter"),
        stages: [stage("draft", "paralegal"), stage("check", "counsel")],
        customization: "none",
      },
    ]);
    expect(result.disabledWorkflows).toEqual([]);
    // The stage role is the roleId of the GP-11 role view.
    expect(result.roles.map((role) => role.roleId)).toContain(
      result.workflows[0]?.stages[0]?.roleId,
    );
  });

  test("workflow and stage identity are the same across two pack versions while effective IDs differ", () => {
    const first = catalog();
    const second = catalog();
    const before = resolve(first, [register(first, v1)]);
    const after = resolve(second, [register(second, v2)]);
    expect(after.workflows.map((item) => item.workflowId)).toEqual(
      before.workflows.map((item) => item.workflowId),
    );
    expect(after.workflows.map((item) => item.effectiveId)).not.toEqual(
      before.workflows.map((item) => item.effectiveId),
    );
    const id = pid("workflows", "review");
    // Identity carries no version, digest or title.
    expect(id).toBe("pack:org.example.legal/workflows/review");
    expect(workflow(before, id)?.title).toBe("Review");
    expect(workflow(after, id)?.title).toBe("Matter review");
    // Stages kept by the new version keep their IDs and their position.
    expect(
      workflow(after, id)
        ?.stages.slice(0, 2)
        .map((item) => item.id),
    ).toEqual(workflow(before, id)?.stages.map((item) => item.id));
  });

  test("a replacement renames a workflow and keeps its identity", () => {
    const target = catalog();
    const pack = register(target, v1);
    const base = resolve(target, [pack]);
    const result = resolve(
      target,
      [pack],
      state(
        [],
        [
          override(pack, "review", "replace", {
            id: "review",
            title: "Our review",
            description: "House procedure",
            taskType: "matter",
            stages: [
              { id: "draft", role: "paralegal" },
              { id: "check", role: "counsel" },
            ],
          }),
        ],
      ),
    );
    const id = pid("workflows", "review");
    expect(workflow(result, id)).toEqual({
      ...workflow(base, id),
      title: "Our review",
      description: "House procedure",
      customization: "replace",
    });
    expect(result.workflows.map((item) => item.workflowId)).toEqual(
      base.workflows.map((item) => item.workflowId),
    );
  });

  test("a replacement changes the task type, reorders, adds and removes stages in exactly the given order", () => {
    const target = catalog();
    const pack = register(target, v1);
    const replace = (stages: object[], taskType = "matter") =>
      workflow(
        resolve(
          target,
          [pack],
          state(
            [],
            [
              override(pack, "review", "replace", {
                id: "review",
                taskType,
                stages,
              }),
            ],
          ),
        ),
        pid("workflows", "review"),
      );
    // Another task type of the same pack.
    expect(
      replace(
        [
          { id: "draft", role: "paralegal" },
          { id: "check", role: "counsel" },
        ],
        "filing",
      )?.taskTypeId,
    ).toBe(pid("taskTypes", "filing"));
    // Reordered: the stage IDs are the same, their order is the project's.
    expect(
      replace([
        { id: "check", role: "counsel" },
        { id: "draft", role: "paralegal" },
      ])?.stages,
    ).toEqual([stage("check", "counsel"), stage("draft", "paralegal")]);
    // A stage added in the middle, and one whose role changes.
    expect(
      replace([
        { id: "draft", role: "clerk" },
        { id: "second-opinion", role: "auditor" },
        { id: "check", role: "counsel" },
      ])?.stages,
    ).toEqual([
      stage("draft", "clerk"),
      stage("second-opinion", "auditor"),
      stage("check", "counsel"),
    ]);
    // A stage removed.
    expect(replace([{ id: "check", role: "counsel" }])?.stages).toEqual([
      stage("check", "counsel"),
    ]);
    // Never sorted: neither by stage ID nor by role.
    const unsorted = [
      { id: "z-last", role: "paralegal" },
      { id: "a-first", role: "counsel" },
      { id: "m-middle", role: "auditor" },
      { id: "B-upper", role: "clerk" },
    ];
    expect(replace(unsorted)?.stages).toEqual(
      unsorted.map((item) => stage(item.id, item.role)),
    );
    // A replacement is never merged with the pack's: no title is inherited.
    expect(replace([])).toEqual({
      workflowId: pid("workflows", "review"),
      effectiveId: `pack:org.example.legal@1.0.0#${pack.manifestDigest}/workflows/review`,
      origin: "pack_owned",
      taskTypeId: pid("taskTypes", "matter"),
      stages: [],
      customization: "replace",
    });
  });

  test("an extension describes a workflow and keeps the pack's task type and stages", () => {
    const target = catalog();
    const pack = register(target, v1);
    const base = resolve(target, [pack]);
    const result = resolve(
      target,
      [pack],
      state(
        [],
        [
          override(pack, "review", "extend", { description: "Two steps" }),
          override(pack, "intake", "extend", { title: "Intake" }),
        ],
      ),
    );
    expect(workflow(result, pid("workflows", "review"))).toEqual({
      ...workflow(base, pid("workflows", "review")),
      description: "Two steps",
      customization: "extend",
    });
    expect(workflow(result, pid("workflows", "intake"))).toEqual({
      ...workflow(base, pid("workflows", "intake")),
      title: "Intake",
      customization: "extend",
    });
    // An extension cannot replace a field the pack sets.
    expect(
      errorCode(() =>
        resolve(
          target,
          [pack],
          state([], [override(pack, "review", "extend", { title: "Ours" })]),
        ),
      ),
    ).toBe("unresolved_override");
  });

  test("a disabled workflow leaves the workflows, is reported by identity and is not resolved", () => {
    const target = catalog();
    const pack = register(target, v1);
    const result = resolve(
      target,
      [pack],
      state([], [override(pack, "intake", "disable")]),
    );
    expect(result.workflows.map((item) => item.workflowId)).toEqual([
      pid("workflows", "audit"),
      pid("workflows", "review"),
    ]);
    expect(result.disabledWorkflows).toEqual([pid("workflows", "intake")]);
    const effectiveId = `pack:org.example.legal@1.0.0#${pack.manifestDigest}/workflows/intake`;
    expect(result.disabledDefinitions).toEqual([effectiveId]);
    expect(
      result.resolvedWorkflowReferences.map((item) => item.workflowId),
    ).not.toContain(effectiveId);
    expect(
      result.effectiveDefinitions.workflows.find(
        (item) => item.effectiveId === effectiveId,
      )?.enabled,
    ).toBe(false);
  });

  test("a role can be omitted once the only workflow that needs it is disabled or drops the stage", () => {
    const target = catalog();
    const pack = register(target, v1);
    const omit = (localId: string) =>
      override(pack, localId, "disable", undefined, "roles");
    // The pack workflow still needs the role: omission fails closed.
    expect(
      errorCode(() => resolve(target, [pack], state([], [omit("clerk")]))),
    ).toBe("disabled_required_definition");
    // Disable the only workflow that uses it, and the role can go.
    const disabled = resolve(
      target,
      [pack],
      state([], [omit("clerk"), override(pack, "intake", "disable")]),
    );
    expect(disabled.omittedRoles).toEqual([pid("roles", "clerk")]);
    expect(disabled.disabledWorkflows).toEqual([pid("workflows", "intake")]);
    // Or replace the workflow so that no stage names the role.
    const replaced = resolve(
      target,
      [pack],
      state(
        [],
        [
          omit("auditor"),
          override(pack, "audit", "replace", {
            id: "audit",
            taskType: "matter",
            stages: [{ id: "inspect", role: "counsel" }],
          }),
        ],
      ),
    );
    expect(replaced.omittedRoles).toEqual([pid("roles", "auditor")]);
    expect(workflow(replaced, pid("workflows", "audit"))?.stages).toEqual([
      stage("inspect", "counsel"),
    ]);
    // A role another enabled workflow still names cannot be omitted this way.
    expect(
      errorCode(() =>
        resolve(
          target,
          [pack],
          state([], [omit("counsel"), override(pack, "intake", "disable")]),
        ),
      ),
    ).toBe("disabled_required_definition");
  });

  test("an uncustomized workflow that names a missing or disabled definition fails closed", () => {
    // The manifest contract does not check workflow references.
    const cases: [Record<string, unknown[]>, string][] = [
      [
        {
          roles: [{ id: "counsel" }],
          taskTypes: [{ id: "matter" }],
          workflows: [
            {
              id: "review",
              taskType: "matter",
              stages: [{ id: "check", role: "ghost" }],
            },
          ],
        },
        "missing_workflow_reference",
      ],
      [
        {
          roles: [{ id: "counsel" }],
          workflows: [
            {
              id: "review",
              taskType: "ghost",
              stages: [{ id: "check", role: "counsel" }],
            },
          ],
        },
        "missing_workflow_reference",
      ],
    ];
    for (const [contributions, code] of cases) {
      const target = catalog();
      const pack = register(target, packBytes("1.0.0", contributions));
      expect(errorCode(() => resolve(target, [pack]))).toBe(code);
      // Disabling the workflow removes the requirement.
      expect(
        resolve(
          target,
          [pack],
          state([], [override(pack, "review", "disable")]),
        ).workflows,
      ).toEqual([]);
    }
    const target = catalog();
    const pack = register(target, v1);
    expect(
      errorCode(() =>
        resolve(
          target,
          [pack],
          state(
            [],
            [override(pack, "paralegal", "disable", undefined, "roles")],
          ),
        ),
      ),
    ).toBe("disabled_required_definition");

    // Project-owned workflows resolve project definitions only.
    const flow = (taskType: string, role: string) =>
      owned("workflows", "ours", {
        id: "ours",
        taskType,
        stages: [{ id: "only", role }],
      });
    const project = (entries: Owned[]) => () =>
      resolve(target, [pack], state(entries));
    expect(
      errorCode(project([flow("task", "missing"), owned("taskTypes", "task")])),
    ).toBe("missing_workflow_reference");
    expect(
      errorCode(project([flow("missing", "role"), owned("roles", "role")])),
    ).toBe("missing_workflow_reference");
    expect(
      errorCode(
        project([
          flow("task", "role"),
          owned("taskTypes", "task", { id: "task" }, false),
          owned("roles", "role"),
        ]),
      ),
    ).toBe("disabled_required_definition");
    expect(
      errorCode(
        project([
          flow("task", "role"),
          owned("taskTypes", "task"),
          owned("roles", "role", { id: "role" }, false),
        ]),
      ),
    ).toBe("disabled_required_definition");
    // A pack definition is outside the project namespace.
    expect(
      errorCode(project([flow("matter", "role"), owned("roles", "role")])),
    ).toBe("missing_workflow_reference");
  });

  test("a customized workflow that names a missing, omitted or disabled definition fails closed", () => {
    const target = catalog();
    const pack = register(target, v1);
    const replace = (taskType: string, role: string, extra: Override[] = []) =>
      errorCode(() =>
        resolve(
          target,
          [pack],
          state(
            [],
            [
              ...extra,
              override(pack, "review", "replace", {
                id: "review",
                taskType,
                stages: [
                  { id: "draft", role: "paralegal" },
                  { id: "check", role },
                ],
              }),
            ],
          ),
        ),
      );
    expect(replace("matter", "ghost")).toBe("missing_workflow_reference");
    expect(replace("ghost", "counsel")).toBe("missing_workflow_reference");
    // The stage names a role the project omits: only `intake` used `clerk`,
    // so the omission alone resolves once `intake` is disabled.
    const omission = [
      override(pack, "clerk", "disable", undefined, "roles"),
      override(pack, "intake", "disable"),
    ];
    expect(resolve(target, [pack], state([], omission)).omittedRoles).toEqual([
      pid("roles", "clerk"),
    ]);
    expect(replace("matter", "clerk", omission)).toBe(
      "disabled_required_definition",
    );
    // An extended workflow keeps the pack's stages and fails the same way.
    expect(
      errorCode(() =>
        resolve(
          target,
          [pack],
          state(
            [],
            [
              override(pack, "clerk", "disable", undefined, "roles"),
              override(pack, "intake", "extend", { title: "Intake" }),
            ],
          ),
        ),
      ),
    ).toBe("disabled_required_definition");
  });

  test("a stage of a customized pack workflow names definitions of the same pack only", () => {
    const target = catalog();
    const pack = register(target, v1);
    const other = register(
      target,
      packBytes(
        "1.0.0",
        {
          roles: [{ id: "engineer" }, { id: "shared" }],
          taskTypes: [{ id: "ticket" }, { id: "common" }],
        },
        "org.example.software",
      ),
    );
    const projectDefinitions = [
      owned("roles", "liaison"),
      owned("roles", "shared-project"),
      owned("taskTypes", "errand"),
    ];
    const replace = (taskType: string, role: string, extra: Owned[] = []) =>
      errorCode(() =>
        resolve(
          target,
          [pack, other],
          state(
            [...projectDefinitions, ...extra],
            [
              override(pack, "review", "replace", {
                id: "review",
                taskType,
                stages: [{ id: "check", role }],
              }),
            ],
          ),
        ),
      );
    // The fixture itself resolves.
    expect(
      resolve(target, [pack, other], state(projectDefinitions)).workflows,
    ).toHaveLength(3);
    // Another selected pack's role or task type.
    expect(replace("matter", "engineer")).toBe("missing_workflow_reference");
    expect(replace("ticket", "counsel")).toBe("missing_workflow_reference");
    // A project-owned role or task type.
    expect(replace("matter", "liaison")).toBe("missing_workflow_reference");
    expect(replace("errand", "counsel")).toBe("missing_workflow_reference");
    // A bare ID that exists in two other namespaces is ambiguous, not chosen.
    const second = register(
      target,
      packBytes(
        "1.0.0",
        { roles: [{ id: "shared" }], taskTypes: [{ id: "common" }] },
        "org.example.finance",
      ),
    );
    const ambiguous = (taskType: string, role: string) =>
      errorCode(() =>
        resolve(
          target,
          [pack, other, second],
          state(
            [],
            [
              override(pack, "review", "replace", {
                id: "review",
                taskType,
                stages: [{ id: "check", role }],
              }),
            ],
          ),
        ),
      );
    expect(ambiguous("matter", "shared")).toBe("ambiguous_reference");
    expect(ambiguous("common", "counsel")).toBe("ambiguous_reference");
  });

  test("a project-owned workflow has a project identity and project references", () => {
    const target = catalog();
    const pack = register(target, v1);
    const flow = (id: string, enabled = true) =>
      owned(
        "workflows",
        id,
        {
          id,
          title: "House flow",
          taskType: "errand",
          stages: [
            { id: "second", role: "liaison" },
            { id: "first", role: "liaison" },
          ],
        },
        enabled,
      );
    const result = resolve(
      target,
      [pack],
      state([
        owned("roles", "liaison"),
        owned("taskTypes", "errand"),
        flow("house"),
        flow("retired", false),
      ]),
    );
    expect(workflow(result, "project:workflows/house")).toEqual({
      workflowId: "project:workflows/house",
      effectiveId: "project:workflows/house",
      origin: "project_owned",
      title: "House flow",
      taskTypeId: "project:taskTypes/errand",
      stages: [
        stage("second", "project:roles/liaison"),
        stage("first", "project:roles/liaison"),
      ],
      customization: "none",
    });
    // Pack workflows first, then project-owned ones, as in every GP-06 list.
    expect(result.workflows.map((item) => item.workflowId)).toEqual([
      pid("workflows", "audit"),
      pid("workflows", "intake"),
      pid("workflows", "review"),
      "project:workflows/house",
    ]);
    expect(result.disabledWorkflows).toEqual(["project:workflows/retired"]);
  });

  test("the workflow view is derived and outside the version-1 digest material", () => {
    const empty = resolveProjectConfiguration({
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
    });
    expect(empty.configurationDigest).toBe(
      "sha256:c272fa286a92c8d3732e97fec7b0373c3a7854cb70e4a108a7690acb92bd7b19",
    );
    expect(empty.workflows).toEqual([]);
    expect(empty.disabledWorkflows).toEqual([]);

    // The digests below were computed before GP-13 changed any code. A
    // configuration without a workflow override keeps its digest, although it
    // now has a workflow view.
    const target = catalog();
    const pack = register(target, v1);
    expect(pack.manifestDigest).toBe(
      "sha256:ee918400c7907fc48fcaadc29f1a395d7172d98b973aaaf950f705e6d06afb03",
    );
    const base = resolve(target, [pack]);
    expect(base.configurationDigest).toBe(
      "sha256:cb946a26a567beb05929dd41bcd10e92b441fce350c4e582e9d3176528870472",
    );
    const customized = state(
      [
        owned("roles", "liaison"),
        owned("taskTypes", "errand"),
        owned("workflows", "house", {
          id: "house",
          taskType: "errand",
          stages: [
            { id: "second", role: "liaison" },
            { id: "first", role: "liaison" },
          ],
        }),
      ],
      [
        override(
          pack,
          "counsel",
          "replace",
          { id: "counsel", title: "Our counsel" },
          "roles",
        ),
        override(
          pack,
          "matter",
          "extend",
          { description: "A case" },
          "taskTypes",
        ),
      ],
    );
    const withoutWorkflowOverride = resolve(target, [pack], customized);
    expect(withoutWorkflowOverride.configurationDigest).toBe(
      "sha256:2faebf0f095ae8ebb8c43fc4f41dcc4428a0eba1c796dd4c18c575b861cb52bd",
    );
    expect(withoutWorkflowOverride.workflows).toHaveLength(4);

    // A workflow override is reflected by the existing digest fields.
    const disabled = resolve(
      target,
      [pack],
      state([], [override(pack, "intake", "disable")]),
    );
    expect(disabled.configurationDigest).not.toBe(base.configurationDigest);
    expect(disabled.appliedOverrides).toEqual([
      {
        effectiveId: `pack:org.example.legal@1.0.0#${pack.manifestDigest}/workflows/intake`,
        operation: "disable",
        revision: 1,
      },
    ]);
    const reordered = (stages: object[]) =>
      resolve(
        target,
        [pack],
        state(
          [],
          [
            override(pack, "review", "replace", {
              id: "review",
              taskType: "matter",
              stages,
            }),
          ],
        ),
      );
    const forward = reordered([
      { id: "draft", role: "paralegal" },
      { id: "check", role: "counsel" },
    ]);
    const backward = reordered([
      { id: "check", role: "counsel" },
      { id: "draft", role: "paralegal" },
    ]);
    // Stage order is content: two orders are two configurations.
    expect(forward.configurationDigest).not.toBe(backward.configurationDigest);
    expect(
      backward.resolvedWorkflowReferences
        .find((item) => item.workflowId.endsWith("/workflows/review"))
        ?.stages.map((item) => item.id),
    ).toEqual(["check", "draft"]);
  });
});

describe("GP-13 workflow customization in the mutation contract", () => {
  const source = {
    id: "org.example.legal",
    version: "1.0.0",
    manifestDigest: `sha256:${"a".repeat(64)}`,
    kind: "workflows",
    localId: "review",
  };
  const put = (operation: string, payload?: unknown, kind = "workflows") => ({
    action: "put_override",
    source: { ...source, kind },
    operation,
    ...(payload === undefined ? {} : { payload }),
  });
  const envelope = {
    id: "review",
    title: "Our review",
    description: "House procedure",
    taskType: "matter",
    stages: [
      { id: "z-last", role: "paralegal" },
      { id: "a-first", role: "counsel" },
    ],
  };

  test("replace, extend and disable are supported for workflows and for no undescribed kind", () => {
    expect(mutationCode(put("replace", envelope))).toBe("accepted");
    expect(mutationCode(put("extend", { title: "Our review" }))).toBe(
      "accepted",
    );
    expect(mutationCode(put("disable"))).toBe("accepted");
    for (const kind of ["policies", "capabilities", "validators"]) {
      expect(mutationCode(put("replace", { id: "review" }, kind))).toBe(
        "unsupported_override_operation",
      );
      expect(mutationCode(put("extend", { title: "Ours" }, kind))).toBe(
        "unsupported_override_operation",
      );
      expect(mutationCode(put("disable", undefined, kind))).toBe(
        "unsupported_override_operation",
      );
    }
    // The kinds that could be disabled before GP-13 still can, others cannot.
    for (const kind of ["prompts", "roles", "agents"])
      expect(mutationCode(put("disable", undefined, kind))).toBe("accepted");
    for (const kind of [
      "taskTypes",
      "artifactTypes",
      "evidenceTypes",
      "knowledge",
    ])
      expect(mutationCode(put("disable", undefined, kind))).toBe(
        "unsupported_override_operation",
      );
  });

  test("a replacement carries the complete workflow envelope with its stages in the given order", () => {
    const parsed = parseDefinitionMutation(put("replace", envelope));
    expect(parsed).toEqual({
      action: "put_override",
      source,
      operation: "replace",
      payload: envelope,
    });
    // Optional fields may be absent; an empty stage list is a valid list.
    expect(
      parseDefinitionMutation(
        put("replace", { id: "review", taskType: "matter", stages: [] }),
      ),
    ).toMatchObject({
      payload: { id: "review", taskType: "matter", stages: [] },
    });
    // The same rules as a project-owned workflow payload.
    expect(
      parseDefinitionMutation({
        action: "put_owned",
        kind: "workflows",
        id: "review",
        enabled: true,
        payload: envelope,
      }),
    ).toMatchObject({ payload: envelope });
  });

  test("malformed workflow envelopes are refused", () => {
    const replace = (payload: unknown) => mutationCode(put("replace", payload));
    const stages = envelope.stages;
    // Not the typed envelope.
    expect(replace({ id: "review", title: "Descriptive only" })).toBe(
      "protected_security_invariant",
    );
    expect(replace({ id: "review", taskType: "matter" })).toBe(
      "protected_security_invariant",
    );
    expect(replace({ id: "review", taskType: "matter", stages: {} })).toBe(
      "protected_security_invariant",
    );
    expect(replace({ id: "other", taskType: "matter", stages })).toBe(
      "protected_security_invariant",
    );
    expect(replace({ taskType: "matter", stages })).toBe(
      "protected_security_invariant",
    );
    // Extra keys: nothing beyond the schema-1 workflow fields.
    for (const extra of [
      { approvals: ["counsel"] },
      { guards: [] },
      { capabilities: ["draft"] },
      { role: "counsel" },
      { enabled: false },
    ])
      expect(replace({ ...envelope, ...extra })).toBe(
        "protected_security_invariant",
      );
    // Malformed references and stages.
    expect(replace({ id: "review", stages })).toBe(
      "malformed_origin_reference",
    );
    expect(replace({ ...envelope, taskType: "no id" })).toBe(
      "malformed_origin_reference",
    );
    expect(replace({ ...envelope, taskType: ["matter"] })).toBe(
      "malformed_origin_reference",
    );
    for (const stage of [
      "check",
      null,
      ["check", "counsel"],
      { id: "check" },
      { role: "counsel" },
      { id: "no id", role: "counsel" },
      { id: "check", role: "no id" },
      { id: "check", role: "counsel", approval: true },
      // A stage title is a GP-10B-2 field; any other key is still unknown.
      { id: "check", role: "counsel", name: "Check" },
      { id: "check", role: ["counsel"] },
      // Qualified references are not schema-1 local IDs.
      { id: "check", role: "project:roles/liaison" },
      { id: "check", role: "org.example.software/engineer" },
    ])
      expect(
        replace({ ...envelope, stages: [stage] }),
        JSON.stringify(stage),
      ).toBe("malformed_origin_reference");
    expect(replace({ ...envelope, title: "x".repeat(16_001) })).toBe(
      "malformed_origin_reference",
    );
    expect(replace({ ...envelope, description: "a\u0000b" })).toBe(
      "malformed_origin_reference",
    );
    expect(replace("review")).toBe("malformed_origin_reference");
    expect(mutationCode(put("replace"))).toBe("malformed_origin_reference");
  });

  test("stage IDs are unique and a workflow holds at most 1,000 stages", () => {
    const replace = (stages: unknown) =>
      mutationCode(
        put("replace", { id: "review", taskType: "matter", stages }),
      );
    expect(
      replace([
        { id: "check", role: "counsel" },
        { id: "check", role: "paralegal" },
      ]),
    ).toBe("conflicting_ownership_metadata");
    // One role may hold several stages.
    expect(
      replace([
        { id: "check", role: "counsel" },
        { id: "sign", role: "counsel" },
      ]),
    ).toBe("accepted");
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `s${index}`,
        role: "counsel",
      }));
    expect(maximumWorkflowStages).toBe(1_000);
    expect(replace(many(1_000))).toBe("accepted");
    expect(replace(many(1_001))).toBe("malformed_origin_reference");
  });

  test("an extension stays descriptive and a disable carries no payload", () => {
    expect(mutationCode(put("extend", { description: "Two steps" }))).toBe(
      "accepted",
    );
    for (const payload of [
      {},
      { id: "review", title: "Ours" },
      { title: "Ours", taskType: "matter" },
      { title: "Ours", stages: [] },
      { stages: envelope.stages },
      envelope,
    ])
      expect(
        mutationCode(put("extend", payload)),
        JSON.stringify(payload),
      ).toBe("protected_security_invariant");
    expect(mutationCode(put("disable", envelope))).toBe(
      "malformed_origin_reference",
    );
    expect(mutationCode(put("disable", { id: "review" }))).toBe(
      "malformed_origin_reference",
    );
    // The workflow fields exist on workflows only.
    for (const kind of ["roles", "agents", "taskTypes", "prompts"])
      expect(mutationCode(put("replace", envelope, kind)), kind).toBe(
        "protected_security_invariant",
      );
  });
});

describe("GP-13 stored workflow state is re-checked by the resolver", () => {
  test("a stored workflow override that violates the contract fails closed", () => {
    const target = catalog();
    const pack = register(target, v1);
    const stored = (operation: Override["operation"], payload?: object) =>
      errorCode(() =>
        resolve(
          target,
          [pack],
          state([], [override(pack, "review", operation, payload)]),
        ),
      );
    const valid = {
      id: "review",
      taskType: "matter",
      stages: [{ id: "check", role: "counsel" }],
    };
    for (const payload of [
      { id: "review", title: "Descriptive only" },
      { ...valid, id: "other" },
      { ...valid, approvals: ["counsel"] },
      { ...valid, taskType: "no id" },
      { ...valid, stages: [{ id: "check", role: "counsel", extra: true }] },
      {
        ...valid,
        stages: [
          { id: "check", role: "counsel" },
          { id: "check", role: "paralegal" },
        ],
      },
      {
        ...valid,
        stages: Array.from({ length: 1_001 }, (_, index) => ({
          id: `s${index}`,
          role: "counsel",
        })),
      },
    ])
      expect(
        stored("replace", payload),
        JSON.stringify(payload).slice(0, 80),
      ).toBe("unresolved_override");
    expect(stored("extend", { title: "Ours", stages: [] })).toBe(
      "unresolved_override",
    );
    expect(stored("disable", valid)).toBe("unresolved_override");
    expect(stored("replace")).toBe("unresolved_override");
    // An override on a kind without an override contract.
    expect(
      errorCode(() =>
        resolve(
          target,
          [pack],
          state(
            [],
            [
              override(
                pack,
                "review",
                "disable",
                undefined,
                "validators" as Override["source"]["kind"],
              ),
            ],
          ),
        ),
      ),
    ).toBe("unresolved_override");
  });

  test("a stored stage list at the bound resolves in its stored order", () => {
    const target = catalog();
    const pack = register(target, v1);
    // Descending IDs: any sort would be visible.
    const stages = Array.from({ length: 1_000 }, (_, index) => ({
      id: `s${String(999 - index).padStart(3, "0")}`,
      role: index % 2 === 0 ? "counsel" : "paralegal",
    }));
    const result = resolve(
      target,
      [pack],
      state(
        [],
        [
          override(pack, "review", "replace", {
            id: "review",
            taskType: "matter",
            stages,
          }),
        ],
      ),
    );
    expect(
      workflow(result, pid("workflows", "review"))?.stages.map(
        (item) => item.id,
      ),
    ).toEqual(stages.map((item) => item.id));
  });
});
