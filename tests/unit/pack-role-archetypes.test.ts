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
    metadata: { name: "Legal", description: "Role archetype fixture" },
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

// counsel is required by the pack workflow; clerk and paralegal are not.
const v1 = packBytes("1.0.0", {
  roles: [
    { id: "counsel", title: "Counsel", capabilities: ["review", "draft"] },
    { id: "clerk", capabilities: ["file"] },
    { id: "paralegal", title: "Paralegal" },
  ],
  taskTypes: [{ id: "matter" }],
  workflows: [
    {
      id: "flow",
      taskType: "matter",
      stages: [
        { id: "intake", role: "counsel" },
        { id: "review", role: "counsel" },
      ],
    },
  ],
  capabilities: [{ id: "draft" }, { id: "file" }, { id: "review" }],
});
// A later version with a renamed counsel and one more counsel capability.
const v2 = packBytes("2.0.0", {
  roles: [
    {
      id: "counsel",
      title: "Lead counsel",
      description: "Signs off",
      capabilities: ["review", "draft", "file"],
    },
    { id: "clerk", capabilities: ["file"] },
    { id: "paralegal", title: "Paralegal" },
  ],
  taskTypes: [{ id: "matter" }],
  workflows: [
    {
      id: "flow",
      taskType: "matter",
      stages: [{ id: "intake", role: "counsel" }],
    },
  ],
  capabilities: [{ id: "draft" }, { id: "file" }, { id: "review" }],
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

const override = (
  pack: Tuple,
  localId: string,
  operation: Override["operation"],
  payload?: object,
): Override => ({
  origin: "project_override",
  source: { ...pack, kind: "roles", localId },
  operation,
  revision: 1,
  ...(payload === undefined
    ? {}
    : { payload: payload as NonNullable<Override["payload"]> }),
  actorId: "operator",
  changedAt: "2026-10-05T00:00:00.000Z",
});

const ownedRole = (id: string, payload: object, enabled = true): Owned => ({
  origin: "project_owned",
  kind: "roles",
  id,
  revision: 1,
  enabled,
  payload: payload as Owned["payload"],
  actorId: "operator",
  changedAt: "2026-10-05T00:00:00.000Z",
});

const role = (result: ReturnType<typeof resolve>, roleId: string) =>
  result.roles.find((item) => item.roleId === roleId);

describe("GP-11 role contract view", () => {
  test("pack roles resolve with stable identities and their declared capabilities", () => {
    const target = catalog();
    const pack = register(target, v1);
    const result = resolve(target, [pack]);
    expect(result.roles).toEqual([
      {
        roleId: "pack:org.example.legal/roles/clerk",
        effectiveId: `pack:org.example.legal@1.0.0#${pack.manifestDigest}/roles/clerk`,
        origin: "pack_owned",
        capabilities: ["pack:org.example.legal/capabilities/file"],
        customization: "none",
      },
      {
        roleId: "pack:org.example.legal/roles/counsel",
        effectiveId: `pack:org.example.legal@1.0.0#${pack.manifestDigest}/roles/counsel`,
        origin: "pack_owned",
        title: "Counsel",
        capabilities: [
          "pack:org.example.legal/capabilities/draft",
          "pack:org.example.legal/capabilities/review",
        ],
        customization: "none",
      },
      {
        roleId: "pack:org.example.legal/roles/paralegal",
        effectiveId: `pack:org.example.legal@1.0.0#${pack.manifestDigest}/roles/paralegal`,
        origin: "pack_owned",
        title: "Paralegal",
        capabilities: [],
        customization: "none",
      },
    ]);
    expect(result.omittedRoles).toEqual([]);
    for (const item of result.roles) {
      expect(item.roleId).not.toContain("1.0.0");
      expect(item.roleId).not.toContain("sha256:");
      expect(item.roleId).not.toContain("Counsel");
    }
  });

  test("identity is unchanged by rename and replace, which change presentation only", () => {
    const target = catalog();
    const pack = register(target, v1);
    const base = resolve(target, [pack]);
    const renamed = resolve(
      target,
      [pack],
      state(
        [],
        [
          override(pack, "counsel", "replace", {
            id: "counsel",
            title: "Avvocato",
            description: "Our lead",
          }),
          override(pack, "clerk", "extend", { title: "Registry clerk" }),
        ],
      ),
    );
    expect(renamed.roles.map((item) => item.roleId)).toEqual(
      base.roles.map((item) => item.roleId),
    );
    expect(role(renamed, "pack:org.example.legal/roles/counsel")).toEqual({
      ...role(base, "pack:org.example.legal/roles/counsel"),
      title: "Avvocato",
      description: "Our lead",
      customization: "replace",
    });
    expect(role(renamed, "pack:org.example.legal/roles/clerk")).toEqual({
      ...role(base, "pack:org.example.legal/roles/clerk"),
      title: "Registry clerk",
      customization: "extend",
    });
    // The workflow still resolves its stages to the replaced slot.
    expect(renamed.resolvedWorkflowReferences).toEqual(
      base.resolvedWorkflowReferences,
    );
    expect(renamed.resolvedWorkflowReferences[0]?.stages[0]?.roleId).toBe(
      role(renamed, "pack:org.example.legal/roles/counsel")?.effectiveId,
    );
  });

  test("identity is the same across two pack versions while effective IDs differ", () => {
    const target = catalog();
    const first = register(target, v1);
    const second = register(target, v2);
    const before = resolve(target, [first]);
    const after = resolve(target, [second]);
    expect(after.roles.map((item) => item.roleId)).toEqual(
      before.roles.map((item) => item.roleId),
    );
    expect(after.roles.map((item) => item.effectiveId)).not.toEqual(
      before.roles.map((item) => item.effectiveId),
    );
    expect(
      role(after, "pack:org.example.legal/roles/counsel")?.capabilities,
    ).toEqual([
      "pack:org.example.legal/capabilities/draft",
      "pack:org.example.legal/capabilities/file",
      "pack:org.example.legal/capabilities/review",
    ]);
  });

  test("replace, extend and disable never change the pack-owned capability set", () => {
    const target = catalog();
    const pack = register(target, v1);
    const base = resolve(target, [pack]);
    const packPayload = (result: ReturnType<typeof resolve>, localId: string) =>
      result.effectiveDefinitions.roles.find((item) => item.localId === localId)
        ?.payload;
    expect(packPayload(base, "counsel")).toEqual({
      id: "counsel",
      title: "Counsel",
      capabilities: ["draft", "review"],
    });

    const replaced = resolve(
      target,
      [pack],
      state([], [override(pack, "counsel", "replace", { id: "counsel" })]),
    );
    // A complete replacement drops the pack title but not the capabilities.
    expect(packPayload(replaced, "counsel")).toEqual({
      id: "counsel",
      capabilities: ["draft", "review"],
    });
    expect(
      role(replaced, "pack:org.example.legal/roles/counsel")?.capabilities,
    ).toEqual(role(base, "pack:org.example.legal/roles/counsel")?.capabilities);

    const extended = resolve(
      target,
      [pack],
      state([], [override(pack, "clerk", "extend", { description: "Files" })]),
    );
    expect(packPayload(extended, "clerk")).toEqual({
      id: "clerk",
      description: "Files",
      capabilities: ["file"],
    });

    const disabled = resolve(
      target,
      [pack],
      state([], [override(pack, "clerk", "disable")]),
    );
    expect(packPayload(disabled, "clerk")).toEqual({
      id: "clerk",
      capabilities: ["file"],
    });
  });

  test("a project payload cannot carry capabilities, as a mutation or as stored state", () => {
    const target = catalog();
    const pack = register(target, v1);
    const source = { ...pack, kind: "roles", localId: "counsel" };
    for (const mutation of [
      {
        action: "put_override",
        source,
        operation: "replace",
        payload: { id: "counsel", capabilities: ["file"] },
      },
      {
        action: "put_override",
        source,
        operation: "replace",
        payload: { id: "counsel", capabilities: [] },
      },
      {
        action: "put_override",
        source,
        operation: "extend",
        payload: { description: "More", capabilities: ["file"] },
      },
      {
        action: "put_owned",
        kind: "roles",
        id: "auditor",
        enabled: true,
        payload: { id: "auditor", capabilities: ["file"] },
      },
    ]) {
      let code = "accepted";
      try {
        parseDefinitionMutation(mutation);
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectDefinitionConflictError);
        code = (error as ProjectDefinitionConflictError).code;
      }
      expect(code).toBe("protected_security_invariant");
    }

    expect(
      errorCode(() =>
        resolve(
          target,
          [pack],
          state(
            [],
            [
              override(pack, "counsel", "replace", {
                id: "counsel",
                capabilities: ["file"],
              }),
            ],
          ),
        ),
      ),
    ).toBe("unresolved_override");
    expect(
      errorCode(() =>
        resolve(
          target,
          [pack],
          state(
            [],
            [override(pack, "clerk", "extend", { capabilities: ["review"] })],
          ),
        ),
      ),
    ).toBe("unresolved_override");
    expect(
      errorCode(() =>
        resolve(
          target,
          [pack],
          state([
            ownedRole("auditor", { id: "auditor", capabilities: ["file"] }),
          ]),
        ),
      ),
    ).toBe("configuration_invariant");
  });

  test("an omitted role leaves the role list and is reported by identity", () => {
    const target = catalog();
    const pack = register(target, v1);
    const result = resolve(
      target,
      [pack],
      state([], [override(pack, "clerk", "disable")]),
    );
    expect(result.roles.map((item) => item.roleId)).toEqual([
      "pack:org.example.legal/roles/counsel",
      "pack:org.example.legal/roles/paralegal",
    ]);
    expect(result.omittedRoles).toEqual(["pack:org.example.legal/roles/clerk"]);
    expect(result.disabledDefinitions).toEqual([
      `pack:org.example.legal@1.0.0#${pack.manifestDigest}/roles/clerk`,
    ]);
  });

  test("omitting a role an enabled pack workflow requires fails closed", () => {
    const target = catalog();
    const pack = register(target, v1);
    expect(
      errorCode(() =>
        resolve(
          target,
          [pack],
          state([], [override(pack, "counsel", "disable")]),
        ),
      ),
    ).toBe("disabled_required_definition");
  });

  test("a disable override is still rejected for kinds other than roles and prompts", () => {
    const target = catalog();
    const pack = register(target, v1);
    expect(
      errorCode(() =>
        resolve(
          target,
          [pack],
          state(
            [],
            [
              {
                ...override(pack, "matter", "disable"),
                source: { ...pack, kind: "taskTypes", localId: "matter" },
              },
            ],
          ),
        ),
      ),
    ).toBe("unresolved_override");
  });

  test("a project-added role has a project identity and no capabilities", () => {
    const target = catalog();
    const pack = register(target, v1);
    const result = resolve(
      target,
      [pack],
      state([
        ownedRole("auditor", { id: "auditor", title: "Auditor" }),
        ownedRole("intern", { id: "intern" }, false),
      ]),
    );
    expect(role(result, "project:roles/auditor")).toEqual({
      roleId: "project:roles/auditor",
      effectiveId: "project:roles/auditor",
      origin: "project_owned",
      title: "Auditor",
      capabilities: [],
      customization: "none",
    });
    // Pack roles first, then project roles, as in every GP-06 list.
    expect(result.roles.at(-1)?.roleId).toBe("project:roles/auditor");
    expect(result.roles).toHaveLength(4);
    expect(result.omittedRoles).toEqual(["project:roles/intern"]);
    // No pack: project roles alone are a valid configuration.
    expect(
      resolve(
        catalog(),
        [],
        state([ownedRole("auditor", { id: "auditor" })]),
      ).roles.map((item) => item.roleId),
    ).toEqual(["project:roles/auditor"]);
  });

  test("the role view is derived and outside the version-1 digest material", () => {
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
    expect(empty.roles).toEqual([]);
    expect(empty.omittedRoles).toEqual([]);

    // A capability-free configuration keeps its pre-GP-11 digest.
    const target = catalog();
    const plain = register(
      target,
      packBytes("1.0.0", { roles: [{ id: "counsel", title: "Counsel" }] }),
    );
    expect(resolve(target, [plain]).configurationDigest).toBe(
      "sha256:16068bc2f1727701c0543cf1a8f31950a0632591252aed634c8f25b62c57307b",
    );
  });
});
