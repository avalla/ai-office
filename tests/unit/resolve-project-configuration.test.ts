import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  computeArtifactDigest,
  computeManifestDigest,
  parseDomainPackManifest,
  type ContributionKind,
  type DomainPackManifest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import type { ProjectPackBinding } from "../../packages/application/src/ports/project-pack-binding-repository.port.ts";
import type { ProjectDefinitionState } from "../../packages/application/src/domain-pack/project-definition.ts";
import {
  ProjectConfigurationResolutionError,
  resolveProjectConfiguration,
} from "../../packages/application/src/domain-pack/resolve-project-configuration.ts";
import { InMemoryInstalledDomainPackCatalog } from "../../packages/runtime-host/src/installed-domain-pack-catalog.ts";
import { ReadProjectConfiguration } from "../../packages/application/src/domain-pack/read-project-configuration.ts";
import type { ProjectPackBindingRepository } from "../../packages/application/src/ports/project-pack-binding-repository.port.ts";
import type { ProjectDefinitionRepository } from "../../packages/application/src/ports/project-definition-repository.port.ts";
import type { ProjectRepository } from "../../packages/application/src/ports/project-repository.port.ts";

const encoder = new TextEncoder();
const provenance = { installerId: "local-distribution", reference: "fixture" };
const catalog = () =>
  new InMemoryInstalledDomainPackCatalog(1, [provenance.installerId]);
type Catalog = ReturnType<typeof catalog>;
type Tuple = ProjectPackBinding["packs"][number];

function fixture(name: string): Uint8Array {
  return readFileSync(
    new URL(`../fixtures/domain-pack/${name}.json`, import.meta.url),
  );
}

function register(target: Catalog, bytes: Uint8Array): Tuple {
  return target.register({
    bytes,
    artifactDigest: computeArtifactDigest(bytes),
    provenance,
  });
}

function modified(
  bytes: Uint8Array,
  change: (manifest: DomainPackManifest) => DomainPackManifest,
): Uint8Array {
  const draft = change(parseDomainPackManifest(bytes));
  return encoder.encode(
    JSON.stringify({ ...draft, manifestDigest: computeManifestDigest(draft) }),
  );
}

function state(
  owned: ProjectDefinitionState["owned"] = [],
  overrides: ProjectDefinitionState["overrides"] = [],
): ProjectDefinitionState {
  return {
    projectId: "project-a",
    revision: owned.length + overrides.length,
    owned,
    overrides,
  };
}

function binding(
  packs: readonly Tuple[],
  configurationRevision = 1,
): ProjectPackBinding {
  return { projectId: "project-a", configurationRevision, packs };
}

function resolve(
  target: Catalog,
  packs: readonly Tuple[],
  definitions = state(),
) {
  return resolveProjectConfiguration({
    projectId: "project-a",
    binding: binding(packs),
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

const owned = (
  kind: ContributionKind,
  id: string,
  payload: ProjectDefinitionState["owned"][number]["payload"],
  enabled = true,
): ProjectDefinitionState["owned"][number] => ({
  origin: "project_owned",
  kind,
  id,
  revision: 1,
  enabled,
  payload,
  actorId: "operator",
  changedAt: "2026-10-03T00:00:00.000Z",
});

describe("GP-06 derived project configuration", () => {
  test("version-1 empty configuration digest vector is portable", () => {
    const result = resolveProjectConfiguration({
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
    expect(result.configurationDigest).toBe(
      "sha256:c272fa286a92c8d3732e97fec7b0373c3a7854cb70e4a108a7690acb92bd7b19",
    );
  });

  test("zero packs supports a complete project-owned workflow and stable pin", () => {
    const target = catalog();
    const definitions = state([
      owned("roles", "counsel", { id: "counsel" }),
      owned("taskTypes", "matter", { id: "matter" }),
      owned("workflows", "review", {
        id: "review",
        taskType: "matter",
        stages: [
          { id: "draft", role: "counsel" },
          { id: "approve", role: "counsel" },
        ],
      }),
    ]);
    const result = resolve(target, [], definitions);
    expect(result.selectedPacks).toEqual([]);
    expect(result.effectiveDefinitions.workflows[0]?.payload).toMatchObject({
      stages: [{ id: "draft" }, { id: "approve" }],
    });
    expect(result.resolvedWorkflowReferences[0]).toMatchObject({
      workflowId: "project:workflows/review",
      taskTypeId: "project:taskTypes/matter",
      stages: [
        { id: "draft", roleId: "project:roles/counsel" },
        { id: "approve", roleId: "project:roles/counsel" },
      ],
    });
    expect(result.pin.configurationDigest).toBe(result.configurationDigest);
    expect(result.origins["project:roles/counsel"]).toMatchObject({
      origin: "project_owned",
      revision: 1,
    });
  });

  test("independent development, legal, manufacturing, and custom packs compose independent of registration and binding order", () => {
    const names = ["development", "legal", "manufacturing", "custom"];
    const first = catalog();
    const tuples = names.map((name) => register(first, fixture(name)));
    const second = catalog();
    for (const name of [...names].reverse()) register(second, fixture(name));
    const a = resolve(first, tuples);
    const b = resolve(second, [...tuples].reverse());
    expect(a).toEqual(b);
    expect(a.effectiveDefinitions.workflows).toHaveLength(3);
    expect(a.configurationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.effectiveDefinitions.workflows[0]?.effectiveId).toContain("pack:");
  });

  test("exact replace, absent-field extend, and optional prompt disable change digest", () => {
    const target = catalog();
    const legal = register(target, fixture("legal"));
    const base = resolve(target, [legal]);
    const replace = state(
      [],
      [
        {
          origin: "project_override",
          source: { ...legal, kind: "roles", localId: "counsel" },
          operation: "replace",
          revision: 1,
          payload: { id: "counsel", title: "Review counsel" },
          actorId: "operator",
          changedAt: "2026-10-03T00:00:00.000Z",
        },
      ],
    );
    const replaced = resolve(target, [legal], replace);
    expect(replaced.effectiveDefinitions.roles[0]?.payload).toMatchObject({
      title: "Review counsel",
    });
    expect(replaced.configurationDigest).not.toBe(base.configurationDigest);
    const extended = state(
      [],
      [
        {
          ...replace.overrides[0]!,
          operation: "extend",
          payload: {
            description: "Matter review",
          } as NonNullable<
            ProjectDefinitionState["overrides"][number]["payload"]
          >,
        },
      ],
    );
    expect(
      resolve(target, [legal], extended).effectiveDefinitions.roles[0]?.payload,
    ).toMatchObject({ title: "Legal", description: "Matter review" });
    const promptBytes = modified(fixture("custom"), (manifest) => ({
      ...manifest,
      contributions: {
        ...manifest.contributions,
        prompts: [
          {
            id: "optional" as DomainPackManifest["contributions"]["prompts"][number]["id"],
          },
        ],
      },
    }));
    const prompt = register(target, promptBytes);
    const disabled = state(
      [],
      [
        {
          origin: "project_override",
          source: { ...prompt, kind: "prompts", localId: "optional" },
          operation: "disable",
          revision: 1,
          actorId: "operator",
          changedAt: "2026-10-03T00:00:00.000Z",
        },
      ],
    );
    expect(
      resolve(target, [prompt], disabled).disabledDefinitions,
    ).toHaveLength(1);
  });

  test("old, missing, and wrong-digest override sources fail without retargeting", () => {
    const target = catalog();
    const legal = register(target, fixture("legal"));
    const source = { ...legal, kind: "roles" as const, localId: "counsel" };
    const entry = {
      origin: "project_override" as const,
      source,
      operation: "replace" as const,
      revision: 1,
      payload: { id: "counsel" },
      actorId: "operator",
      changedAt: "2026-10-03T00:00:00.000Z",
    };
    expect(errorCode(() => resolve(target, [], state([], [entry])))).toBe(
      "unresolved_override",
    );
    expect(
      errorCode(() =>
        resolve(
          target,
          [legal],
          state([], [{ ...entry, source: { ...source, localId: "missing" } }]),
        ),
      ),
    ).toBe("unresolved_override");
    expect(
      errorCode(() =>
        resolve(
          target,
          [legal],
          state(
            [],
            [
              {
                ...entry,
                source: {
                  ...source,
                  manifestDigest:
                    `sha256:${"0".repeat(64)}` as typeof legal.manifestDigest,
                },
              },
            ],
          ),
        ),
      ),
    ).toBe("unresolved_override");
    const newer = modified(fixture("legal"), (manifest) => ({
      ...manifest,
      version: "2.0.0" as typeof manifest.version,
    }));
    const upgraded = register(target, newer);
    expect(
      errorCode(() => resolve(target, [upgraded], state([], [entry]))),
    ).toBe("unresolved_override");
  });

  test("source loss, collision, missing workflow reference, and unsupported policy fail closed", () => {
    const target = catalog();
    const legal = register(target, fixture("legal"));
    expect(errorCode(() => resolve(catalog(), [legal]))).toBe(
      "pack_unavailable",
    );
    expect(
      errorCode(() =>
        resolve(
          target,
          [legal],
          state([owned("roles", "counsel", { id: "counsel" })]),
        ),
      ),
    ).toBe("duplicate_effective_definition");
    const badWorkflow = state([
      owned("taskTypes", "matter", { id: "matter" }),
      owned("workflows", "review", {
        id: "review",
        taskType: "matter",
        stages: [{ id: "draft", role: "missing" }],
      }),
    ]);
    expect(errorCode(() => resolve(catalog(), [], badWorkflow))).toBe(
      "missing_workflow_reference",
    );
    const policyBytes = modified(fixture("custom"), (manifest) => ({
      ...manifest,
      contributions: {
        ...manifest.contributions,
        policies: [
          {
            id: "mandatory" as DomainPackManifest["contributions"]["policies"][number]["id"],
          },
        ],
      },
    }));
    const policy = register(target, policyBytes);
    expect(errorCode(() => resolve(target, [policy]))).toBe(
      "unsupported_security_composition",
    );
  });

  test("project rows and override rows may arrive in any order", () => {
    const target = catalog();
    const legal = register(target, fixture("legal"));
    const development = register(target, fixture("development"));
    const entries = [
      owned("roles", "operator", { id: "operator" }),
      owned("taskTypes", "case", { id: "case" }),
    ];
    const overrides: ProjectDefinitionState["overrides"] = [
      {
        origin: "project_override",
        source: { ...legal, kind: "roles", localId: "counsel" },
        operation: "replace",
        revision: 1,
        payload: { id: "counsel", title: "Lead" },
        actorId: "a",
        changedAt: "2026-10-03T00:00:00.000Z",
      },
      {
        origin: "project_override",
        source: { ...development, kind: "roles", localId: "reviewer" },
        operation: "extend",
        revision: 1,
        payload: {
          description: "Peer review",
        } as NonNullable<
          ProjectDefinitionState["overrides"][number]["payload"]
        >,
        actorId: "b",
        changedAt: "2026-10-03T00:00:00.000Z",
      },
    ];
    const first = resolve(
      target,
      [legal, development],
      state(entries, overrides),
    );
    const second = resolve(
      target,
      [development, legal],
      state([...entries].reverse(), [...overrides].reverse()),
    );
    expect(first).toEqual(second);
    const changed = resolve(
      target,
      [development, legal],
      state(entries, [
        { ...overrides[0]!, payload: { id: "counsel", title: "Different" } },
        overrides[1]!,
      ]),
    );
    expect(changed.configurationDigest).not.toBe(first.configurationDigest);
  });

  test("project workflow cannot guess a role across pack namespaces", () => {
    const target = catalog();
    const development = register(target, fixture("development"));
    const duplicated = modified(fixture("legal"), (manifest) => ({
      ...manifest,
      contributions: {
        ...manifest.contributions,
        roles: [
          ...manifest.contributions.roles,
          {
            id: "reviewer" as DomainPackManifest["contributions"]["roles"][number]["id"],
          },
        ],
      },
    }));
    const legal = register(target, duplicated);
    const definitions = state([
      owned("taskTypes", "case", { id: "case" }),
      owned("workflows", "review", {
        id: "review",
        taskType: "case",
        stages: [{ id: "check", role: "reviewer" }],
      }),
    ]);
    expect(
      errorCode(() => resolve(target, [development, legal], definitions)),
    ).toBe("ambiguous_reference");
  });

  test("missing task type and disabled role cannot satisfy a project workflow", () => {
    const workflow = owned("workflows", "review", {
      id: "review",
      taskType: "case",
      stages: [{ id: "check", role: "operator" }],
    });
    expect(errorCode(() => resolve(catalog(), [], state([workflow])))).toBe(
      "missing_workflow_reference",
    );
    expect(
      errorCode(() =>
        resolve(
          catalog(),
          [],
          state([
            owned("taskTypes", "case", { id: "case" }),
            owned("roles", "operator", { id: "operator" }, false),
            workflow,
          ]),
        ),
      ),
    ).toBe("disabled_required_definition");
  });

  test("coherent-read service rejects revision changes between source reads", async () => {
    let calls = 0;
    const base = binding([]);
    const bindings = {
      get: async () => ({ ...base, configurationRevision: ++calls }),
    } as unknown as ProjectPackBindingRepository;
    const definitions = {
      get: async () => state(),
    } as unknown as ProjectDefinitionRepository;
    const projects = {
      findById: async () => ({ id: "project-a" }),
    } as unknown as ProjectRepository;
    const service = new ReadProjectConfiguration({
      projects,
      bindings,
      definitions,
      catalog: catalog(),
      transactions: { run: async (work) => work() },
    });
    await expect(service.read("project-a")).rejects.toMatchObject({
      code: "stale_resolution",
    });
  });
});
