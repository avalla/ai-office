import { createHash } from "node:crypto";
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
import {
  compareExactSources,
  type ProjectDefinitionState,
} from "../../packages/application/src/domain-pack/project-definition.ts";
import { ProjectNotFoundError } from "../../packages/application/src/errors.ts";
import {
  ProjectConfigurationResolutionError,
  resolveProjectConfiguration,
} from "../../packages/application/src/domain-pack/resolve-project-configuration.ts";
import { InMemoryInstalledDomainPackCatalog } from "../../packages/runtime-host/src/installed-domain-pack-catalog.ts";
import { ReadProjectConfiguration } from "../../packages/application/src/domain-pack/read-project-configuration.ts";
import type { ProjectPackBindingRepository } from "../../packages/application/src/ports/project-pack-binding-repository.port.ts";
import type { ProjectDefinitionRepository } from "../../packages/application/src/ports/project-definition-repository.port.ts";
import type { InstalledDomainPackCatalog } from "../../packages/application/src/ports/installed-domain-pack-catalog.port.ts";
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

const kinds = [
  "roles",
  "taskTypes",
  "workflows",
  "agents",
  "artifactTypes",
  "evidenceTypes",
  "policies",
  "knowledge",
  "capabilities",
  "prompts",
  "validators",
] as const;
type Contributions = Partial<
  Record<(typeof kinds)[number], readonly Record<string, unknown>[]>
>;

/** A synthetic schema-1 pack derived from a fixture, with its own digest. */
function syntheticPack(
  id: string,
  contributions: Contributions = {},
  dependencies: readonly Tuple[] = [],
  version = "1.0.0",
): Uint8Array {
  return modified(
    fixture("custom"),
    (manifest) =>
      ({
        ...manifest,
        id,
        version,
        dependencies,
        contributions: Object.fromEntries(
          kinds.map((kind) => [kind, contributions[kind] ?? []]),
        ),
      }) as unknown as DomainPackManifest,
  );
}

const override = (
  tuple: Tuple,
  kind: ContributionKind,
  localId: string,
  operation: ProjectDefinitionState["overrides"][number]["operation"],
  // Extend payloads are partial: stored without the source's exact ID.
  payload?: { id?: string; title?: string; description?: string },
  revision = 1,
): ProjectDefinitionState["overrides"][number] => ({
  origin: "project_override",
  source: { ...tuple, kind, localId },
  operation,
  revision,
  ...(payload === undefined
    ? {}
    : {
        payload: payload as NonNullable<
          ProjectDefinitionState["overrides"][number]["payload"]
        >,
      }),
  actorId: "operator",
  changedAt: "2026-10-03T00:00:00.000Z",
});

/** Independent RFC 8785 subset: sorted keys, no whitespace, JSON scalars. */
function independentCanonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(independentCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        (key) =>
          `${JSON.stringify(key)}:${independentCanonicalJson(record[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function independentDigest(
  result: ReturnType<typeof resolveProjectConfiguration>,
): string {
  // The GP-11 role view and the GP-12 agent view are derived from the
  // material; they are not part of it.
  const {
    configurationDigest: _digest,
    pin: _pin,
    roles: _roles,
    omittedRoles: _omittedRoles,
    agents: _agents,
    disabledAgents: _disabledAgents,
    ...material
  } = result;
  return `sha256:${createHash("sha256")
    .update(
      `ai-office-project-configuration-v1\n${independentCanonicalJson(material)}`,
    )
    .digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe("GP-06 hardening", () => {
  test("adapter-owned pack properties never enter selected, closure, provenance, pin, or digest", () => {
    const target = catalog();
    const dependency = register(
      target,
      syntheticPack("org.example.dependency", { roles: [{ id: "worker" }] }),
    );
    const parent = register(
      target,
      syntheticPack("org.example.parent", { roles: [{ id: "lead" }] }, [
        dependency,
      ]),
    );
    const baseline = resolve(target, [parent]);
    const adapter: InstalledDomainPackCatalog = {
      coreContractVersion: target.coreContractVersion,
      read: (id, version) => {
        const artifact = target.read(id, version);
        return (
          artifact && {
            ...artifact,
            identity: { ...artifact.identity, installer: "adapter-local" },
          }
        );
      },
      list: () => target.list(),
      trusts: (value) => target.trusts(value),
    };
    const adapterBinding = { ...parent, localPath: "/private/adapter/path" };
    const extra = resolveProjectConfiguration({
      projectId: "project-a",
      binding: binding([adapterBinding]),
      definitions: state(),
      catalog: adapter,
      coreContractVersion: 1,
    });
    const tuple = (identity: Tuple) => ({
      id: identity.id,
      version: identity.version,
      manifestDigest: identity.manifestDigest,
    });
    expect(extra.selectedPacks).toEqual([tuple(parent)]);
    expect(extra.resolvedPacks).toEqual([tuple(dependency), tuple(parent)]);
    expect(extra.pin.selectedPacks).toEqual(extra.selectedPacks);
    expect(extra.pin.resolvedPacks).toEqual(extra.resolvedPacks);
    for (const provenance of Object.values(extra.origins))
      if (provenance.origin === "pack_owned")
        expect(Object.keys(provenance.pack)).toEqual([
          "id",
          "version",
          "manifestDigest",
        ]);
    expect(JSON.stringify(extra)).not.toMatch(
      /localPath|installer|adapter-local/u,
    );
    expect(extra.configurationDigest).toBe(baseline.configurationDigest);

    const nextVersion = register(
      target,
      syntheticPack(
        "org.example.parent",
        { roles: [{ id: "lead" }] },
        [dependency],
        "2.0.0",
      ),
    );
    expect(resolve(target, [nextVersion]).configurationDigest).not.toBe(
      baseline.configurationDigest,
    );
  });

  test("an override may only target an explicitly selected pack, never a dependency-only pack", () => {
    const target = catalog();
    const dependency = register(
      target,
      syntheticPack("org.example.base", { roles: [{ id: "analyst" }] }),
    );
    const selected = register(
      target,
      syntheticPack("org.example.app", {}, [dependency]),
    );
    const hijack = state(
      [],
      [
        override(dependency, "roles", "analyst", "replace", {
          id: "analyst",
          title: "Hijacked",
        }),
      ],
    );
    expect(errorCode(() => resolve(target, [selected], hijack))).toBe(
      "unresolved_override",
    );
    const explicit = resolve(target, [selected, dependency], hijack);
    expect(explicit.appliedOverrides).toHaveLength(1);
    const plain = resolve(target, [selected]);
    expect(plain.selectedPacks).toEqual([selected]);
    expect(plain.resolvedPacks.map((pack) => pack.id)).toEqual([
      "org.example.app",
      "org.example.base",
    ]);
    expect(
      plain.effectiveDefinitions.roles.map((role) => role.payload),
    ).toEqual([{ id: "analyst" }]);
  });

  test("only the exact verified closure participates; ambient catalog entries never leak", () => {
    const target = catalog();
    const shared = register(
      target,
      syntheticPack("org.example.shared", { roles: [{ id: "shared" }] }),
    );
    const left = register(
      target,
      syntheticPack("org.example.left", { roles: [{ id: "left" }] }, [shared]),
    );
    const right = register(
      target,
      syntheticPack("org.example.right", { roles: [{ id: "right" }] }, [
        shared,
      ]),
    );
    // Installed but unselected: a newer version of a selected pack, a pack
    // with schema-1 policies, and an unrelated pack reusing a local ID.
    register(
      target,
      syntheticPack(
        "org.example.left",
        { roles: [{ id: "left" }, { id: "leak" }] },
        [shared],
        "2.0.0",
      ),
    );
    register(
      target,
      syntheticPack("org.example.policy", { policies: [{ id: "deny" }] }),
    );
    register(
      target,
      syntheticPack("org.example.noise", { roles: [{ id: "left" }] }),
    );
    const result = resolve(target, [right, left]);
    expect(result.resolvedPacks.map((pack) => pack.id)).toEqual([
      "org.example.left",
      "org.example.right",
      "org.example.shared",
    ]);
    expect(
      result.effectiveDefinitions.roles.map((role) => role.localId),
    ).toEqual(["left", "right", "shared"]);
    expect(JSON.stringify(result)).not.toMatch(/leak|noise|policy|2\.0\.0/u);

    const isolated = catalog();
    register(
      isolated,
      syntheticPack("org.example.shared", {
        roles: [{ id: "shared" }],
      }),
    );
    register(
      isolated,
      syntheticPack("org.example.right", { roles: [{ id: "right" }] }, [
        shared,
      ]),
    );
    register(
      isolated,
      syntheticPack("org.example.left", { roles: [{ id: "left" }] }, [shared]),
    );
    expect(resolve(isolated, [left, right]).configurationDigest).toBe(
      result.configurationDigest,
    );
  });

  test("closure failures are typed and never fall back to another installed version", () => {
    const target = catalog();
    const missing = {
      ...register(catalog(), syntheticPack("org.example.absent")),
    };
    const dependent = register(
      target,
      syntheticPack("org.example.needs", {}, [missing]),
    );
    expect(errorCode(() => resolve(target, [dependent]))).toBe(
      "pack_dependency_failure",
    );
    const v1 = register(target, syntheticPack("org.example.multi"));
    const v2 = register(
      target,
      syntheticPack("org.example.multi", {}, [], "2.0.0"),
    );
    expect(errorCode(() => resolve(target, [v1, v2]))).toBe(
      "pack_dependency_failure",
    );
    expect(
      errorCode(() =>
        resolve(target, [{ ...v1, manifestDigest: v2.manifestDigest }]),
      ),
    ).toBe("pack_unavailable");
    expect(errorCode(() => resolve(target, [missing]))).toBe(
      "pack_unavailable",
    );
    expect(errorCode(() => resolve(target, [v1, v1]))).toBe(
      "configuration_invariant",
    );
    const untrusted = {
      coreContractVersion: 1,
      list: () => target.list(),
      read: (...args: Parameters<Catalog["read"]>) => target.read(...args),
      trusts: () => false,
    };
    expect(
      errorCode(() =>
        resolveProjectConfiguration({
          projectId: "project-a",
          binding: binding([v1]),
          definitions: state(),
          catalog: untrusted,
          coreContractVersion: 1,
        }),
      ),
    ).toBe("pack_unavailable");
    const policyDependency = register(
      target,
      syntheticPack("org.example.policy", { policies: [{ id: "deny" }] }),
    );
    const policyParent = register(
      target,
      syntheticPack("org.example.parent", {}, [policyDependency]),
    );
    expect(errorCode(() => resolve(target, [policyParent]))).toBe(
      "unsupported_security_composition",
    );
  });

  test("derived order follows GP-07 code-unit tuple order, not concatenated IDs or locale", () => {
    const target = catalog();
    // "org.a.b" is a prefix of "org.a.b-c": tuple order and concatenated
    // effective-ID order disagree, and "Z" < "a" only in code-unit order.
    const short = register(
      target,
      syntheticPack("org.a.b", { roles: [{ id: "a" }, { id: "Z" }] }),
    );
    const long = register(
      target,
      syntheticPack("org.a.b-c", { roles: [{ id: "a" }] }),
    );
    const overrides = [
      override(long, "roles", "a", "extend", { title: "Long" }),
      override(short, "roles", "a", "extend", { title: "Short" }),
      override(short, "roles", "Z", "extend", { title: "Upper" }),
    ];
    const ownedEntries = [
      owned("roles", "b", { id: "b" }),
      owned("roles", "B", { id: "B" }),
      owned("agents", "z", { id: "z" }),
      owned("roles", "b-1", { id: "b-1" }),
      owned("roles", "b.1", { id: "b.1" }),
    ];
    const result = resolve(
      target,
      [long, short],
      state(ownedEntries, overrides),
    );
    const canonical = [...overrides]
      .sort((a, b) => compareExactSources(a.source, b.source))
      .map((item) => `${item.source.id}/${item.source.localId}`);
    expect(canonical).toEqual(["org.a.b/Z", "org.a.b/a", "org.a.b-c/a"]);
    const label = (effectiveId: string) => {
      const origin = result.origins[effectiveId]!;
      return origin.origin === "pack_owned"
        ? `${origin.pack.id}/${origin.localId}`
        : `project/${origin.kind}/${origin.localId}`;
    };
    expect(
      result.appliedOverrides.map((item) => label(item.effectiveId)),
    ).toEqual(canonical);
    expect(
      result.effectiveDefinitions.roles.map((item) => label(item.effectiveId)),
    ).toEqual([
      ...canonical,
      "project/roles/B",
      "project/roles/b",
      "project/roles/b-1",
      "project/roles/b.1",
    ]);
    expect(Object.keys(result.origins).map(label)).toEqual([
      ...canonical,
      "project/agents/z",
      "project/roles/B",
      "project/roles/b",
      "project/roles/b-1",
      "project/roles/b.1",
    ]);
    expect(result.projectOwnedDefinitions.map((item) => item.localId)).toEqual([
      "z",
      "B",
      "b",
      "b-1",
      "b.1",
    ]);
    const permuted = resolve(
      target,
      [short, long],
      state([...ownedEntries].reverse(), [...overrides].reverse()),
    );
    expect(JSON.stringify(permuted)).toBe(JSON.stringify(result));
  });

  test("stored definitions violating the GP-07 contract fail closed with sanitized diagnostics", () => {
    const target = catalog();
    const bad = (
      entry: Record<string, unknown>,
    ): ProjectDefinitionState["owned"][number] =>
      ({
        ...owned("roles", "a", { id: "a" }),
        ...entry,
      }) as unknown as ProjectDefinitionState["owned"][number];
    const stages = (count: number, duplicate = false) =>
      Array.from({ length: count }, (_, index) => ({
        id: duplicate ? "same" : `s${index}`,
        role: "r",
      }));
    const cases: [string, Record<string, unknown>, string][] = [
      [
        "identity mismatch",
        { payload: { id: "b" } },
        "configuration_invariant",
      ],
      [
        "authority-shaped payload keys",
        { payload: { id: "a", capabilities: ["fs.write"], grants: ["*"] } },
        "configuration_invariant",
      ],
      ["null payload", { payload: null }, "configuration_invariant"],
      ["array payload", { payload: [] }, "configuration_invariant"],
      ["non-boolean enabled", { enabled: "false" }, "configuration_invariant"],
      [
        "malformed local ID",
        { id: "../secret path", payload: { id: "../secret path" } },
        "configuration_invariant",
      ],
      ["zero entry revision", { revision: 0 }, "configuration_invariant"],
      ["fractional revision", { revision: 1.5 }, "configuration_invariant"],
      ["unknown kind", { kind: "__proto__" }, "configuration_invariant"],
      [
        "workflow fields on a role",
        { payload: { id: "a", taskType: "t", stages: [] } },
        "configuration_invariant",
      ],
      [
        "workflow without stages",
        { kind: "workflows", payload: { id: "a", taskType: "t" } },
        "configuration_invariant",
      ],
      [
        "workflow above the GP-07 stage bound",
        {
          kind: "workflows",
          payload: { id: "a", taskType: "t", stages: stages(1_001) },
        },
        "configuration_invariant",
      ],
      [
        "duplicate workflow stage",
        {
          kind: "workflows",
          payload: { id: "a", taskType: "t", stages: stages(2, true) },
        },
        "configuration_invariant",
      ],
      [
        "project policy",
        { kind: "policies" },
        "unsupported_security_composition",
      ],
      [
        "project capability",
        { kind: "capabilities" },
        "unsupported_security_composition",
      ],
      [
        "project validator",
        { kind: "validators" },
        "unsupported_security_composition",
      ],
    ];
    for (const [name, entry, code] of cases) {
      let caught: unknown;
      try {
        resolve(target, [], state([bad(entry)]));
      } catch (error) {
        caught = error;
      }
      expect(caught, name).toBeInstanceOf(ProjectConfigurationResolutionError);
      const failure = caught as ProjectConfigurationResolutionError;
      expect(failure.code, name).toBe(code);
      expect(failure.message, name).not.toMatch(/secret|fs\.write|__proto__/u);
    }
    expect(
      errorCode(() =>
        resolve(
          target,
          [],
          state([
            owned("roles", "a", { id: "a" }),
            owned("roles", "a", { id: "a" }),
          ]),
        ),
      ),
    ).toBe("duplicate_effective_definition");
    // Exactly the GP-07 bound is accepted.
    const bounded = resolve(
      target,
      [],
      state([
        owned("taskTypes", "t", { id: "t" }),
        owned("roles", "r", { id: "r" }),
        owned("workflows", "w", {
          id: "w",
          taskType: "t",
          stages: stages(1_000),
        }),
      ]),
    );
    expect(bounded.resolvedWorkflowReferences[0]!.stages).toHaveLength(1_000);
  });

  test("the override matrix is GP-07's: every other shape fails closed", () => {
    const target = catalog();
    const pack = register(
      target,
      syntheticPack("org.example.matrix", {
        roles: [{ id: "plain" }, { id: "titled", title: "Source" }],
        taskTypes: [{ id: "task" }],
        workflows: [
          {
            id: "flow",
            taskType: "task",
            stages: [{ id: "s", role: "plain" }],
          },
        ],
        capabilities: [{ id: "cap" }],
        validators: [{ id: "val" }],
        prompts: [{ id: "prompt" }],
      }),
    );
    const attempt = (entry: ProjectDefinitionState["overrides"][number]) =>
      errorCode(() => resolve(target, [pack], state([], [entry])));
    const raw = (entry: Record<string, unknown>) =>
      ({
        ...override(pack, "roles", "plain", "replace", { id: "plain" }),
        ...entry,
      }) as unknown as ProjectDefinitionState["overrides"][number];
    for (const entry of [
      override(pack, "taskTypes", "task", "disable"),
      override(pack, "workflows", "flow", "replace", { id: "flow" }),
      override(pack, "workflows", "flow", "extend", { title: "x" }),
      override(pack, "capabilities", "cap", "replace", { id: "cap" }),
      override(pack, "validators", "val", "extend", { title: "x" }),
      override(pack, "roles", "titled", "extend", { title: "Clobber" }),
      override(pack, "roles", "plain", "replace", { id: "other" }),
      override(pack, "roles", "Plain", "replace", { id: "Plain" }),
      override(pack, "taskTypes", "plain", "replace", { id: "plain" }),
      override(pack, "prompts", "prompt", "disable", { id: "prompt" }),
      raw({ operation: "merge" }),
      raw({ payload: { id: "plain", stages: [] } }),
      raw({ payload: { id: "plain", title: 7 } }),
      raw({ operation: "extend", payload: {} }),
      raw({ operation: "extend", payload: { id: "plain", title: "x" } }),
      raw({ source: { ...pack, kind: "roles", localId: "plain", extra: 1 } }),
      raw({ source: { ...pack, kind: "roles" } }),
    ])
      expect(attempt(entry), JSON.stringify(entry)).toBe("unresolved_override");
    // GP-11: a role omission is a supported shape, but `plain` is required by
    // the enabled workflow, so it still fails closed.
    expect(attempt(override(pack, "roles", "plain", "disable"))).toBe(
      "disabled_required_definition",
    );
    expect(attempt(raw({ revision: 0 }))).toBe("configuration_invariant");
    expect(attempt(raw({ revision: Number.NaN }))).toBe(
      "configuration_invariant",
    );
    expect(
      errorCode(() =>
        resolve(
          target,
          [pack],
          state(
            [],
            [
              override(pack, "roles", "plain", "replace", { id: "plain" }),
              override(pack, "roles", "plain", "extend", { title: "x" }),
            ],
          ),
        ),
      ),
    ).toBe("duplicate_effective_definition");
    // Disabling a prompt never unlinks it from the workflow graph, and a
    // replaced role stays the same qualified target.
    const composed = resolve(
      target,
      [pack],
      state(
        [],
        [
          override(pack, "prompts", "prompt", "disable"),
          override(pack, "roles", "plain", "replace", {
            id: "plain",
            title: "Replaced",
          }),
          override(pack, "roles", "titled", "extend", { description: "More" }),
        ],
      ),
    );
    expect(composed.disabledDefinitions).toHaveLength(1);
    expect(composed.disabledDefinitions[0]).toMatch(/\/prompts\/prompt$/u);
    expect(
      composed.effectiveDefinitions.roles.map((role) => role.payload),
    ).toEqual([
      { id: "plain", title: "Replaced" },
      { id: "titled", title: "Source", description: "More" },
    ]);
    expect(composed.resolvedWorkflowReferences[0]!.stages[0]!.roleId).toMatch(
      /^pack:org\.example\.matrix@1\.0\.0#sha256:[0-9a-f]{64}\/roles\/plain$/u,
    );
  });

  test("bare workflow references never cross a namespace boundary", () => {
    const target = catalog();
    const provider = register(
      target,
      syntheticPack("org.example.provider", {
        roles: [{ id: "shared-role" }],
        taskTypes: [{ id: "shared-task" }],
      }),
    );
    const consumer = register(
      target,
      syntheticPack(
        "org.example.consumer",
        {
          taskTypes: [{ id: "task" }],
          workflows: [
            {
              id: "flow",
              taskType: "task",
              stages: [{ id: "s", role: "shared-role" }],
            },
          ],
        },
        [provider],
      ),
    );
    // A pack workflow cannot reach its own dependency through a bare ID.
    expect(errorCode(() => resolve(target, [consumer, provider]))).toBe(
      "missing_workflow_reference",
    );
    // Nor a project-owned definition; the collision rule keeps the project
    // from shadowing the pack's namespace in the other direction.
    const projectTask = register(
      target,
      syntheticPack("org.example.wants-project", {
        roles: [{ id: "r" }],
        workflows: [
          {
            id: "flow",
            taskType: "owned-task",
            stages: [{ id: "s", role: "r" }],
          },
        ],
      }),
    );
    expect(
      errorCode(() =>
        resolve(
          target,
          [projectTask],
          state([owned("taskTypes", "owned-task", { id: "owned-task" })]),
        ),
      ),
    ).toBe("missing_workflow_reference");
    expect(
      errorCode(() =>
        resolve(
          target,
          [provider],
          state([owned("roles", "shared-role", { id: "shared-role" })]),
        ),
      ),
    ).toBe("duplicate_effective_definition");
    // A project workflow sees only project-owned targets, case-sensitively.
    const project = [
      owned("taskTypes", "Task", { id: "Task" }),
      owned("roles", "Role", { id: "Role" }),
    ];
    const workflow = (taskType: string, role: string, enabled = true) =>
      owned(
        "workflows",
        "w",
        { id: "w", taskType, stages: [{ id: "s", role }] },
        enabled,
      );
    expect(
      errorCode(() =>
        resolve(target, [], state([...project, workflow("task", "Role")])),
      ),
    ).toBe("missing_workflow_reference");
    expect(
      errorCode(() =>
        resolve(
          target,
          [provider],
          state([...project, workflow("shared-task", "Role")]),
        ),
      ),
    ).toBe("missing_workflow_reference");
    const resolved = resolve(
      target,
      [provider],
      state([...project, workflow("Task", "Role")]),
    );
    expect(resolved.resolvedWorkflowReferences).toEqual([
      {
        workflowId: "project:workflows/w",
        taskTypeId: "project:taskTypes/Task",
        stages: [{ id: "s", roleId: "project:roles/Role" }],
      },
    ]);
    // A disabled workflow is listed as disabled and exposes no targets.
    const disabled = resolve(
      target,
      [],
      state([workflow("nowhere", "nobody", false)]),
    );
    expect(disabled.resolvedWorkflowReferences).toEqual([]);
    expect(disabled.disabledDefinitions).toEqual(["project:workflows/w"]);
  });

  test("the digest covers every semantic input and nothing local", () => {
    const build = (
      change: {
        packTitle?: string;
        packVersion?: string;
        ownedTitle?: string;
        ownedEnabled?: boolean;
        ownedRevision?: number;
        overrideTitle?: string;
        overrideRevision?: number;
        workflowRole?: string;
        disablePrompt?: boolean;
        bindingRevision?: number;
        definitionRevision?: number;
        actorId?: string;
        changedAt?: string;
        reference?: string;
        projectId?: string;
        extraInstalled?: boolean;
      } = {},
    ) => {
      const target = catalog();
      const bytes = syntheticPack(
        "org.example.digest",
        {
          roles: [{ id: "role", description: change.packTitle ?? "Source" }],
          prompts: [{ id: "prompt" }],
        },
        [],
        change.packVersion ?? "1.0.0",
      );
      const tuple = target.register({
        bytes,
        artifactDigest: computeArtifactDigest(bytes),
        provenance: {
          installerId: provenance.installerId,
          reference: change.reference ?? "fixture",
        },
      });
      if (change.extraInstalled)
        register(target, syntheticPack("org.example.unselected"));
      const projectIdentifier = change.projectId ?? "project-a";
      const stamp = <T extends object>(entry: T): T => ({
        ...entry,
        actorId: change.actorId ?? "operator",
        changedAt: change.changedAt ?? "2026-10-03T00:00:00.000Z",
      });
      return resolveProjectConfiguration({
        projectId: projectIdentifier,
        binding: {
          projectId: projectIdentifier,
          configurationRevision: change.bindingRevision ?? 1,
          packs: [tuple],
        },
        definitions: {
          projectId: projectIdentifier,
          revision: change.definitionRevision ?? 4,
          owned: [
            stamp(owned("taskTypes", "t", { id: "t" })),
            stamp({
              ...owned(
                "roles",
                "r1",
                { id: "r1", title: change.ownedTitle ?? "Owned \u{1F600} é" },
                change.ownedEnabled ?? true,
              ),
              revision: change.ownedRevision ?? 1,
            }),
            stamp(owned("roles", "r2", { id: "r2" })),
            stamp(
              owned("workflows", "w", {
                id: "w",
                taskType: "t",
                stages: [{ id: "s", role: change.workflowRole ?? "r2" }],
              }),
            ),
          ],
          overrides: [
            stamp(
              override(
                tuple,
                "roles",
                "role",
                "extend",
                { title: change.overrideTitle ?? "Extended" },
                change.overrideRevision ?? 1,
              ),
            ),
            ...(change.disablePrompt
              ? [stamp(override(tuple, "prompts", "prompt", "disable"))]
              : []),
          ],
        },
        catalog: target,
        coreContractVersion: 1,
      });
    };
    const baseline = build();
    expect(baseline.configurationDigest).toBe(independentDigest(baseline));
    expect(baseline.pin).toEqual({
      configurationDigest: baseline.configurationDigest,
      coreContractVersion: 1,
      bindingRevision: 1,
      definitionRevision: 4,
      selectedPacks: baseline.selectedPacks,
      resolvedPacks: baseline.resolvedPacks,
    });
    const semantic = [
      { packTitle: "Changed manifest content" },
      { packVersion: "1.0.1" },
      { ownedTitle: "Owned" },
      { ownedTitle: "" },
      { ownedEnabled: false },
      { ownedRevision: 2 },
      { overrideTitle: "Other" },
      { overrideRevision: 2 },
      { workflowRole: "r1" },
      { disablePrompt: true },
      { bindingRevision: 2 },
      { definitionRevision: 5 },
    ];
    const digests = new Set([baseline.configurationDigest]);
    for (const change of semantic) {
      const changed = build(change);
      expect(changed.configurationDigest, JSON.stringify(change)).toBe(
        independentDigest(changed),
      );
      expect(changed.pin.configurationDigest).toBe(changed.configurationDigest);
      digests.add(changed.configurationDigest);
    }
    expect(digests.size).toBe(semantic.length + 1);
    for (const local of [
      { actorId: "someone-else" },
      { changedAt: "2031-01-01T00:00:00.000Z" },
      { reference: "/home/operator/.local/packs/digest.json" },
      { projectId: "another-runtime-row" },
      { extraInstalled: true },
    ]) {
      const same = build(local);
      expect(same.configurationDigest, JSON.stringify(local)).toBe(
        baseline.configurationDigest,
      );
      expect(JSON.stringify(same)).toBe(JSON.stringify(baseline));
      expect(JSON.stringify(same)).not.toMatch(
        /operator|someone-else|\/home\/|fixture|2031|another-runtime-row/u,
      );
    }
  });

  test("resolution is pure: frozen inputs resolve and fail without being changed", () => {
    const target = catalog();
    const pack = register(
      target,
      syntheticPack("org.example.frozen", { roles: [{ id: "role" }] }),
    );
    const good = deepFreeze(
      state(
        [owned("roles", "mine", { id: "mine" })],
        [override(pack, "roles", "role", "extend", { title: "x" })],
      ),
    );
    const frozenBinding = deepFreeze(binding([pack]));
    const before = JSON.stringify([good, frozenBinding, target.list()]);
    const input = {
      projectId: "project-a",
      binding: frozenBinding,
      definitions: good,
      catalog: target,
      coreContractVersion: 1,
    };
    const first = resolveProjectConfiguration(input);
    expect(resolveProjectConfiguration(input)).toEqual(first);
    const failing = deepFreeze(
      state([], [override(pack, "roles", "gone", "extend", { title: "x" })]),
    );
    expect(
      errorCode(() =>
        resolveProjectConfiguration({ ...input, definitions: failing }),
      ),
    ).toBe("unresolved_override");
    expect(JSON.stringify([good, frozenBinding, target.list()])).toBe(before);
  });

  test("large valid configurations resolve without quadratic scans", () => {
    const target = catalog();
    const count = 4_000;
    const roles = Array.from({ length: count }, (_, index) => ({
      id: `role-${index}`,
    }));
    const pack = register(
      target,
      syntheticPack("org.example.large", { roles }),
    );
    const ownedRoles = roles.map((role) =>
      owned("roles", `own-${role.id}`, { id: `own-${role.id}` }),
    );
    const workflows = Array.from({ length: 20 }, (_, index) =>
      owned("workflows", `w${index}`, {
        id: `w${index}`,
        taskType: "t",
        stages: Array.from({ length: 1_000 }, (_, stage) => ({
          id: `s${stage}`,
          role: `own-role-${(stage * 7 + index) % count}`,
        })),
      }),
    );
    const result = resolve(
      target,
      [pack],
      state(
        [owned("taskTypes", "t", { id: "t" }), ...ownedRoles, ...workflows],
        roles.map((role) =>
          override(pack, "roles", role.id, "extend", { title: "T" }),
        ),
      ),
    );
    expect(result.appliedOverrides).toHaveLength(count);
    expect(result.effectiveDefinitions.roles).toHaveLength(count * 2);
    expect(result.resolvedWorkflowReferences).toHaveLength(20);
    expect(result.resolvedWorkflowReferences[0]!.stages).toHaveLength(1_000);
  });

  describe("coherent read service", () => {
    type Step = "binding" | "definitions";
    function service(
      commits: readonly {
        readonly after: Step;
        readonly read: number;
        readonly changes: Step;
      }[],
    ) {
      // Emulates read-committed storage: every get observes the latest commit.
      const revisions = { binding: 1, definitions: 1 };
      const reads = { binding: 0, definitions: 0 };
      const calls: string[] = [];
      const commit = (step: Step) => {
        for (const item of commits)
          if (item.after === step && reads[step] === item.read)
            revisions[item.changes] += 1;
      };
      const guard = <T extends object>(name: string, port: T): T =>
        new Proxy(port, {
          get(target, property) {
            if (!(property in target))
              throw new Error(`Unexpected ${name}.${String(property)} call`);
            calls.push(`${name}.${String(property)}`);
            return target[property as keyof T];
          },
        });
      return {
        calls,
        reader: new ReadProjectConfiguration({
          projects: guard("projects", {
            findById: async (id: string) =>
              id === "project-a" ? { id } : null,
          }) as unknown as ProjectRepository,
          bindings: guard("bindings", {
            get: async () => {
              reads.binding += 1;
              const value = binding([], revisions.binding);
              commit("binding");
              return value;
            },
          }) as unknown as ProjectPackBindingRepository,
          definitions: guard("definitions", {
            get: async () => {
              reads.definitions += 1;
              const value = { ...state(), revision: revisions.definitions };
              commit("definitions");
              return value;
            },
          }) as unknown as ProjectDefinitionRepository,
          catalog: catalog(),
          transactions: { run: async (work) => work() },
        }),
      };
    }

    test("returns one coherent observation and performs only reads", async () => {
      const { reader, calls } = service([]);
      const result = await reader.read("project-a");
      expect([result.bindingRevision, result.definitionRevision]).toEqual([
        1, 1,
      ]);
      expect(new Set(calls)).toEqual(
        new Set(["projects.findById", "bindings.get", "definitions.get"]),
      );
    });

    test.each([
      [
        "the binding changes while definitions are read",
        { after: "definitions", read: 1, changes: "binding" },
      ],
      [
        "definitions change between their head and confirming read",
        { after: "definitions", read: 1, changes: "definitions" },
      ],
    ] as const)("fails deterministically when %s", async (_name, commit) => {
      const { reader, calls } = service([commit]);
      await expect(reader.read("project-a")).rejects.toMatchObject({
        code: "stale_resolution",
      });
      expect(new Set(calls)).toEqual(
        new Set(["projects.findById", "bindings.get", "definitions.get"]),
      );
    });

    test.each([
      [
        "before the first definition read",
        { after: "binding", read: 1, changes: "definitions" },
        [1, 2],
      ],
      [
        "after both confirming reads",
        { after: "definitions", read: 2, changes: "definitions" },
        [1, 1],
      ],
    ] as const)(
      "a commit %s still yields one coherent snapshot",
      async (_name, commit, expected) => {
        const { reader } = service([commit]);
        const result = await reader.read("project-a");
        expect([result.bindingRevision, result.definitionRevision]).toEqual(
          expected,
        );
      },
    );

    test("an unknown project is a typed not-found error before any source read", async () => {
      const { reader, calls } = service([]);
      await expect(reader.read("project-b")).rejects.toBeInstanceOf(
        ProjectNotFoundError,
      );
      expect(calls).toEqual(["projects.findById"]);
    });
  });
});
