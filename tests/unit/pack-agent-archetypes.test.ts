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
  maximumAgentReferences,
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
    metadata: { name: "Legal", description: "Agent archetype fixture" },
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
    { id: "counsel", title: "Counsel", capabilities: ["review", "draft"] },
    { id: "clerk", capabilities: ["file"] },
    { id: "paralegal" },
  ],
  prompts: [{ id: "brief" }, { id: "style" }, { id: "tone" }],
  knowledge: [{ id: "precedents" }, { id: "statutes" }],
  capabilities: [{ id: "draft" }, { id: "file" }, { id: "review" }],
};
const v1 = packBytes("1.0.0", {
  ...shared,
  agents: [
    {
      id: "drafter",
      title: "Drafter",
      role: "counsel",
      prompts: ["style", "brief"],
      knowledge: ["statutes"],
      capabilities: ["draft"],
    },
    { id: "filer", role: "clerk", capabilities: ["file"] },
    { id: "researcher", title: "Researcher", knowledge: ["precedents"] },
    { id: "plain" },
  ],
});
// A later version: the drafter is renamed and requests one more capability.
const v2 = packBytes("2.0.0", {
  ...shared,
  agents: [
    {
      id: "drafter",
      title: "Lead drafter",
      role: "counsel",
      prompts: ["brief"],
      capabilities: ["draft", "review"],
    },
    { id: "filer", role: "clerk", capabilities: ["file"] },
    { id: "researcher", title: "Researcher", knowledge: ["precedents"] },
    { id: "plain" },
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
  kind: Override["source"]["kind"] = "agents",
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

const agent = (result: ReturnType<typeof resolve>, agentId: string) =>
  result.agents.find((item) => item.agentId === agentId);
const pid = (kind: string, localId: string) =>
  `pack:org.example.legal/${kind}/${localId}`;

describe("GP-12 agent contract view", () => {
  test("pack agents resolve with stable identities and stable references", () => {
    const target = catalog();
    const pack = register(target, v1);
    const result = resolve(target, [pack]);
    const effective = (localId: string) =>
      `pack:org.example.legal@1.0.0#${pack.manifestDigest}/agents/${localId}`;
    expect(result.agents).toEqual([
      {
        agentId: pid("agents", "drafter"),
        effectiveId: effective("drafter"),
        origin: "pack_owned",
        title: "Drafter",
        roleId: pid("roles", "counsel"),
        prompts: [pid("prompts", "brief"), pid("prompts", "style")],
        knowledge: [pid("knowledge", "statutes")],
        capabilities: [pid("capabilities", "draft")],
        customization: "none",
      },
      {
        agentId: pid("agents", "filer"),
        effectiveId: effective("filer"),
        origin: "pack_owned",
        roleId: pid("roles", "clerk"),
        prompts: [],
        knowledge: [],
        capabilities: [pid("capabilities", "file")],
        customization: "none",
      },
      {
        agentId: pid("agents", "plain"),
        effectiveId: effective("plain"),
        origin: "pack_owned",
        prompts: [],
        knowledge: [],
        capabilities: [],
        customization: "none",
      },
      {
        agentId: pid("agents", "researcher"),
        effectiveId: effective("researcher"),
        origin: "pack_owned",
        title: "Researcher",
        prompts: [],
        knowledge: [pid("knowledge", "precedents")],
        capabilities: [],
        customization: "none",
      },
    ]);
    expect(result.disabledAgents).toEqual([]);
    // The role reference is the roleId of the GP-11 role view.
    expect(result.roles.map((item) => item.roleId)).toContain(
      agent(result, pid("agents", "drafter"))?.roleId,
    );
  });

  test("identity is the same across two pack versions while effective IDs differ", () => {
    const target = catalog();
    const first = register(target, v1);
    const second = register(target, v2);
    const before = resolve(target, [first]);
    const after = resolve(target, [second]);
    expect(after.agents.map((item) => item.agentId)).toEqual(
      before.agents.map((item) => item.agentId),
    );
    expect(after.agents.map((item) => item.effectiveId)).not.toEqual(
      before.agents.map((item) => item.effectiveId),
    );
    expect(agent(after, pid("agents", "drafter"))).toMatchObject({
      title: "Lead drafter",
      prompts: [pid("prompts", "brief")],
      knowledge: [],
      capabilities: [
        pid("capabilities", "draft"),
        pid("capabilities", "review"),
      ],
    });
  });

  test("a replacement controls name, role, prompts, knowledge and requested capabilities and keeps the identity", () => {
    const target = catalog();
    const pack = register(target, v1);
    const plain = resolve(target, [pack]);
    const replaced = resolve(
      target,
      [pack],
      state(
        [],
        [
          override(pack, "filer", "replace", {
            id: "filer",
            title: "Our reviewer",
            description: "Reviews filings",
            role: "counsel",
            prompts: ["brief", "tone"],
            knowledge: ["precedents", "statutes"],
            capabilities: ["review"],
          }),
        ],
      ),
    );
    expect(agent(replaced, pid("agents", "filer"))).toEqual({
      agentId: pid("agents", "filer"),
      effectiveId: agent(plain, pid("agents", "filer"))?.effectiveId,
      origin: "pack_owned",
      title: "Our reviewer",
      description: "Reviews filings",
      roleId: pid("roles", "counsel"),
      prompts: [pid("prompts", "brief"), pid("prompts", "tone")],
      knowledge: [pid("knowledge", "precedents"), pid("knowledge", "statutes")],
      capabilities: [pid("capabilities", "review")],
      customization: "replace",
    });
    expect(replaced.agents.map((item) => item.agentId)).toEqual(
      plain.agents.map((item) => item.agentId),
    );
    // The replacement is the effective payload, so the digest reflects it.
    expect(
      replaced.effectiveDefinitions.agents.find(
        (item) => item.localId === "filer",
      )?.payload,
    ).toEqual({
      id: "filer",
      title: "Our reviewer",
      description: "Reviews filings",
      role: "counsel",
      prompts: ["brief", "tone"],
      knowledge: ["precedents", "statutes"],
      capabilities: ["review"],
    });
    expect(replaced.configurationDigest).not.toBe(plain.configurationDigest);
  });

  test("a replacement is never merged with the pack's references", () => {
    const target = catalog();
    const pack = register(target, v1);
    const result = resolve(
      target,
      [pack],
      state([], [override(pack, "drafter", "replace", { id: "drafter" })]),
    );
    expect(agent(result, pid("agents", "drafter"))).toEqual({
      agentId: pid("agents", "drafter"),
      effectiveId: `pack:org.example.legal@1.0.0#${pack.manifestDigest}/agents/drafter`,
      origin: "pack_owned",
      prompts: [],
      knowledge: [],
      capabilities: [],
      customization: "replace",
    });
  });

  test("an extension renames and keeps every pack reference", () => {
    const target = catalog();
    const pack = register(target, v1);
    const result = resolve(
      target,
      [pack],
      state(
        [],
        [override(pack, "filer", "extend", { title: "Filing assistant" })],
      ),
    );
    expect(agent(result, pid("agents", "filer"))).toMatchObject({
      agentId: pid("agents", "filer"),
      title: "Filing assistant",
      roleId: pid("roles", "clerk"),
      capabilities: [pid("capabilities", "file")],
      customization: "extend",
    });
  });

  test("a project customization that requests more than the role declares fails closed", () => {
    const target = catalog();
    const pack = register(target, v1);
    const attempt = (payload: object) =>
      errorCode(() =>
        resolve(
          target,
          [pack],
          state([], [override(pack, "filer", "replace", payload)]),
        ),
      );
    // `draft` is counsel's, not clerk's.
    expect(
      attempt({ id: "filer", role: "clerk", capabilities: ["draft"] }),
    ).toBe("agent_capability_exceeds_role");
    expect(
      attempt({ id: "filer", role: "clerk", capabilities: ["file", "review"] }),
    ).toBe("agent_capability_exceeds_role");
    // paralegal declares no capability at all.
    expect(
      attempt({ id: "filer", role: "paralegal", capabilities: ["file"] }),
    ).toBe("agent_capability_exceeds_role");
    // Inside the set it resolves.
    expect(
      agent(
        resolve(
          target,
          [pack],
          state(
            [],
            [
              override(pack, "filer", "replace", {
                id: "filer",
                role: "counsel",
                capabilities: ["draft", "review"],
              }),
            ],
          ),
        ),
        pid("agents", "filer"),
      )?.capabilities,
    ).toEqual([pid("capabilities", "draft"), pid("capabilities", "review")]);
  });

  test("a renamed or replaced role does not widen what its agents may request", () => {
    const target = catalog();
    const pack = register(target, v1);
    // The role's set is pack-owned under every role override (GP-11).
    expect(
      errorCode(() =>
        resolve(
          target,
          [pack],
          state(
            [],
            [
              override(pack, "filer", "replace", {
                id: "filer",
                role: "clerk",
                capabilities: ["draft"],
              }),
              override(
                pack,
                "clerk",
                "replace",
                { id: "clerk", title: "Senior clerk" },
                "roles",
              ),
            ],
          ),
        ),
      ),
    ).toBe("agent_capability_exceeds_role");
  });

  test("a reference that does not resolve in the agent's own pack fails closed", () => {
    const target = catalog();
    const pack = register(target, v1);
    for (const payload of [
      { id: "filer", role: "partner" },
      { id: "filer", prompts: ["brief", "closing"] },
      { id: "filer", knowledge: ["treaties"] },
      // `sign` is not a capability of this pack at all.
      { id: "filer", role: "counsel", capabilities: ["sign"] },
    ])
      expect(
        errorCode(() =>
          resolve(
            target,
            [pack],
            state([], [override(pack, "filer", "replace", payload)]),
          ),
        ),
        JSON.stringify(payload),
      ).toBe("missing_agent_reference");
    // A project-owned role is outside the pack agent's namespace.
    expect(
      errorCode(() =>
        resolve(
          target,
          [pack],
          state(
            [owned("roles", "auditor")],
            [
              override(pack, "filer", "replace", {
                id: "filer",
                role: "auditor",
              }),
            ],
          ),
        ),
      ),
    ).toBe("missing_agent_reference");
  });

  test("an agent whose role is omitted, or whose prompt is disabled, fails closed", () => {
    const target = catalog();
    const pack = register(target, v1);
    const omitClerk = override(pack, "clerk", "disable", undefined, "roles");
    expect(
      errorCode(() => resolve(target, [pack], state([], [omitClerk]))),
    ).toBe("disabled_required_definition");
    expect(
      errorCode(() =>
        resolve(
          target,
          [pack],
          state([], [override(pack, "brief", "disable", undefined, "prompts")]),
        ),
      ),
    ).toBe("disabled_required_definition");
    // Disabling the agent as well takes its references out of the picture.
    const result = resolve(
      target,
      [pack],
      state([], [override(pack, "filer", "disable"), omitClerk]),
    );
    expect(result.disabledAgents).toEqual([pid("agents", "filer")]);
    expect(result.omittedRoles).toEqual([pid("roles", "clerk")]);
    // So does replacing it with an agent that no longer names the role.
    expect(
      agent(
        resolve(
          target,
          [pack],
          state(
            [],
            [override(pack, "filer", "replace", { id: "filer" }), omitClerk],
          ),
        ),
        pid("agents", "filer"),
      ),
    ).toMatchObject({ customization: "replace", capabilities: [] });
  });

  test("a disabled agent leaves the agent list and is reported by identity", () => {
    const target = catalog();
    const pack = register(target, v1);
    const result = resolve(
      target,
      [pack],
      state([], [override(pack, "drafter", "disable")]),
    );
    expect(result.agents.map((item) => item.agentId)).toEqual([
      pid("agents", "filer"),
      pid("agents", "plain"),
      pid("agents", "researcher"),
    ]);
    expect(result.disabledAgents).toEqual([pid("agents", "drafter")]);
    expect(result.disabledDefinitions).toEqual([
      `pack:org.example.legal@1.0.0#${pack.manifestDigest}/agents/drafter`,
    ]);
  });

  test("a project-added agent has a project identity, project references and no capabilities", () => {
    const target = catalog();
    const pack = register(target, v1);
    const result = resolve(
      target,
      [pack],
      state([
        owned("agents", "helper", {
          id: "helper",
          title: "Helper",
          role: "auditor",
          prompts: ["voice", "house"],
          knowledge: ["handbook"],
        }),
        owned("agents", "idle", { id: "idle", role: "auditor" }, false),
        owned("agents", "bare"),
        owned("knowledge", "handbook"),
        owned("prompts", "house"),
        owned("prompts", "voice"),
        owned("roles", "auditor"),
      ]),
    );
    expect(agent(result, "project:agents/helper")).toEqual({
      agentId: "project:agents/helper",
      effectiveId: "project:agents/helper",
      origin: "project_owned",
      title: "Helper",
      roleId: "project:roles/auditor",
      prompts: ["project:prompts/house", "project:prompts/voice"],
      knowledge: ["project:knowledge/handbook"],
      capabilities: [],
      customization: "none",
    });
    expect(agent(result, "project:agents/bare")).toEqual({
      agentId: "project:agents/bare",
      effectiveId: "project:agents/bare",
      origin: "project_owned",
      prompts: [],
      knowledge: [],
      capabilities: [],
      customization: "none",
    });
    // Pack agents first, then project agents, as in every GP-06 list.
    expect(result.agents.map((item) => item.agentId).slice(-2)).toEqual([
      "project:agents/bare",
      "project:agents/helper",
    ]);
    expect(result.disabledAgents).toEqual(["project:agents/idle"]);
    // No pack: project agents alone are a valid configuration.
    expect(
      resolve(
        catalog(),
        [],
        state([
          owned("agents", "helper", { id: "helper", role: "auditor" }),
          owned("roles", "auditor"),
        ]),
      ).agents.map((item) => item.roleId),
    ).toEqual(["project:roles/auditor"]);
  });

  test("a project-added agent resolves project definitions only", () => {
    const target = catalog();
    const pack = register(target, v1);
    const attempt = (payload: object, extra: readonly Owned[] = []) =>
      errorCode(() =>
        resolve(
          target,
          [pack],
          state([owned("agents", "helper", payload), ...extra]),
        ),
      );
    // `counsel` and `brief` exist in the pack, not in the project.
    expect(attempt({ id: "helper", role: "counsel" })).toBe(
      "missing_agent_reference",
    );
    expect(attempt({ id: "helper", prompts: ["brief"] })).toBe(
      "missing_agent_reference",
    );
    expect(attempt({ id: "helper", knowledge: ["statutes"] })).toBe(
      "missing_agent_reference",
    );
    // A disabled project role is not a usable role.
    expect(
      attempt({ id: "helper", role: "auditor" }, [
        owned("roles", "auditor", { id: "auditor" }, false),
      ]),
    ).toBe("disabled_required_definition");
    // A bare name that two packs provide is not guessed.
    const other = register(
      target,
      packBytes("1.0.0", { roles: [{ id: "counsel" }] }, "org.example.other"),
    );
    expect(
      errorCode(() =>
        resolve(
          target,
          [pack, other],
          state([owned("agents", "helper", { id: "helper", role: "counsel" })]),
        ),
      ),
    ).toBe("ambiguous_reference");
  });

  test("the agent view is derived and outside the version-1 digest material", () => {
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
    expect(empty.agents).toEqual([]);
    expect(empty.disabledAgents).toEqual([]);

    const descriptive = {
      roles: [{ id: "counsel", title: "Counsel", capabilities: ["review"] }],
      capabilities: [{ id: "review" }],
      prompts: [{ id: "brief" }],
      knowledge: [{ id: "statutes" }],
    };
    // An agent-free configuration keeps its pre-GP-12 digest.
    const agentFree = catalog();
    const without = register(agentFree, packBytes("1.0.0", descriptive));
    expect(without.manifestDigest).toBe(
      "sha256:55dd820e3bbcb4587a57c2936318b1a7243e15a1e983640bef67c411d28a82a9",
    );
    expect(resolve(agentFree, [without]).configurationDigest).toBe(
      "sha256:570eed04cfc458cdb369de10ee5f9e396aae5fd83ffdc88636534698cc6ee97e",
    );

    // So does one whose pack and project agents use none of the new fields,
    // although it now has an agent view.
    const target = catalog();
    const pack = register(
      target,
      packBytes("1.0.0", {
        ...descriptive,
        agents: [{ id: "drafter", title: "Drafter" }, { id: "reviewer" }],
      }),
    );
    expect(pack.manifestDigest).toBe(
      "sha256:beedc3c5a44ce1968ac7dded1499b24ce935dc71689b5b1738715d7e1d35f654",
    );
    const result = resolve(
      target,
      [pack],
      state(
        [owned("agents", "helper", { id: "helper", title: "Helper" })],
        [
          override(pack, "drafter", "replace", {
            id: "drafter",
            title: "Our drafter",
          }),
          override(pack, "reviewer", "extend", { title: "Our reviewer" }),
        ],
      ),
    );
    expect(result.configurationDigest).toBe(
      "sha256:c38cbaefeccbf9741c38a9017fded53d54eeafe4cedfa9fc26c7445286ed8ca1",
    );
    expect(result.agents.map((item) => item.agentId)).toEqual([
      pid("agents", "drafter"),
      pid("agents", "reviewer"),
      "project:agents/helper",
    ]);
  });
});

describe("GP-12 agent customization in the mutation contract", () => {
  const tuple = {
    id: "org.example.legal",
    version: "1.0.0",
    manifestDigest: `sha256:${"a".repeat(64)}`,
  };
  const put = (
    operation: string,
    payload?: object,
    kind = "agents",
    localId = "drafter",
  ) => ({
    action: "put_override",
    source: { ...tuple, kind, localId },
    operation,
    ...(payload === undefined ? {} : { payload }),
  });
  const own = (payload: object, kind = "agents") => ({
    action: "put_owned",
    kind,
    id: "helper",
    enabled: true,
    payload,
  });

  test("a replacement carries the complete agent envelope with its lists in one order", () => {
    const parsed = parseDefinitionMutation(
      put("replace", {
        id: "drafter",
        title: "Our drafter",
        role: "counsel",
        prompts: ["tone", "brief"],
        knowledge: ["statutes", "precedents"],
        capabilities: ["review", "draft"],
      }),
    );
    expect(parsed).toMatchObject({
      action: "put_override",
      operation: "replace",
      payload: {
        id: "drafter",
        title: "Our drafter",
        role: "counsel",
        prompts: ["brief", "tone"],
        knowledge: ["precedents", "statutes"],
        capabilities: ["draft", "review"],
      },
    });
    // Absent fields stay absent.
    const bare = parseDefinitionMutation(put("replace", { id: "drafter" }));
    expect(bare.action === "put_override" && bare.payload).toEqual({
      id: "drafter",
    });
  });

  test("a project-owned agent may reference a role, prompts and knowledge, never capabilities", () => {
    const parsed = parseDefinitionMutation(
      own({
        id: "helper",
        role: "auditor",
        prompts: ["voice", "house"],
        knowledge: ["handbook"],
      }),
    );
    expect(parsed.action === "put_owned" && parsed.payload).toEqual({
      id: "helper",
      role: "auditor",
      prompts: ["house", "voice"],
      knowledge: ["handbook"],
    });
    expect(mutationCode(own({ id: "helper", capabilities: ["file"] }))).toBe(
      "protected_security_invariant",
    );
    expect(
      mutationCode(
        own({ id: "helper", role: "auditor", capabilities: ["file"] }),
      ),
    ).toBe("protected_security_invariant");
  });

  test("an agent can be disabled; a disable carries no payload", () => {
    expect(mutationCode(put("disable"))).toBe("accepted");
    expect(mutationCode(put("disable", { id: "drafter" }))).toBe(
      "malformed_origin_reference",
    );
    // Kinds without a disable contract stay unsupported.
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

  test("requested capabilities need a role", () => {
    expect(
      mutationCode(put("replace", { id: "drafter", capabilities: ["draft"] })),
    ).toBe("agent_capability_exceeds_role");
  });

  test.each([
    ["a non-string role", { role: 7 }, "malformed_origin_reference"],
    ["a malformed role", { role: "no id" }, "malformed_origin_reference"],
    [
      "a qualified role",
      { role: "org.example.other/roles/counsel" },
      "malformed_origin_reference",
    ],
    ["a non-array list", { prompts: "brief" }, "malformed_origin_reference"],
    ["an empty list", { knowledge: [] }, "malformed_origin_reference"],
    [
      "a malformed entry",
      { prompts: ["brief", "no id"] },
      "malformed_origin_reference",
    ],
    [
      "a non-string entry",
      { role: "counsel", capabilities: [7] },
      "malformed_origin_reference",
    ],
    [
      "a duplicate prompt",
      { prompts: ["brief", "brief"] },
      "conflicting_ownership_metadata",
    ],
    [
      "a duplicate knowledge entry",
      { knowledge: ["statutes", "statutes"] },
      "conflicting_ownership_metadata",
    ],
    [
      "a duplicate capability",
      { role: "counsel", capabilities: ["draft", "draft"] },
      "conflicting_ownership_metadata",
    ],
    // Model, tools, pipeline participation and approval eligibility are not
    // part of GP-12.
    ["a model", { model: "large" }, "protected_security_invariant"],
    ["tools", { tools: ["shell"] }, "protected_security_invariant"],
    ["pipelines", { pipelines: ["flow"] }, "protected_security_invariant"],
    ["approval", { approver: true }, "protected_security_invariant"],
  ])("a replacement with %s is rejected", (_label, fields, code) => {
    expect(mutationCode(put("replace", { id: "drafter", ...fields }))).toBe(
      code,
    );
  });

  test("a reference list holds at most 1,000 entries", () => {
    expect(maximumAgentReferences).toBe(1_000);
    const names = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `p${String(index).padStart(4, "0")}`,
      );
    for (const field of ["prompts", "knowledge", "capabilities"]) {
      const payload = (count: number) => ({
        id: "drafter",
        role: "counsel",
        [field]: names(count),
      });
      expect(mutationCode(put("replace", payload(1_000))), field).toBe(
        "accepted",
      );
      expect(mutationCode(put("replace", payload(1_001))), field).toBe(
        "malformed_origin_reference",
      );
    }
    for (const field of ["prompts", "knowledge"]) {
      expect(mutationCode(own({ id: "helper", [field]: names(1_000) }))).toBe(
        "accepted",
      );
      expect(mutationCode(own({ id: "helper", [field]: names(1_001) }))).toBe(
        "malformed_origin_reference",
      );
    }
  });

  test("the reference fields exist on agents only and never on an extension", () => {
    for (const fields of [
      { role: "counsel" },
      { prompts: ["brief"] },
      { knowledge: ["statutes"] },
      { role: "counsel", capabilities: ["draft"] },
    ]) {
      expect(
        mutationCode(put("extend", { title: "Renamed", ...fields })),
        JSON.stringify(fields),
      ).toBe("protected_security_invariant");
      for (const kind of ["taskTypes", "knowledge", "prompts"]) {
        expect(
          mutationCode(put("replace", { id: "drafter", ...fields }, kind)),
        ).toBe("protected_security_invariant");
        expect(mutationCode(own({ id: "helper", ...fields }, kind))).toBe(
          "protected_security_invariant",
        );
      }
    }
    // A role still cannot carry a role, prompt or knowledge reference.
    for (const fields of [{ role: "counsel" }, { prompts: ["brief"] }])
      expect(
        mutationCode(put("replace", { id: "drafter", ...fields }, "roles")),
      ).toBe("protected_security_invariant");
  });
});

describe("GP-12 stored agent state is re-checked by the resolver", () => {
  test("a stored payload that violates the contract fails closed", () => {
    const target = catalog();
    const pack = register(target, v1);
    for (const payload of [
      { id: "filer", capabilities: ["file"] },
      { id: "filer", role: "clerk", capabilities: [] },
      { id: "filer", prompts: ["brief", "brief"] },
      { id: "filer", model: "large" },
    ])
      expect(
        errorCode(() =>
          resolve(
            target,
            [pack],
            state([], [override(pack, "filer", "replace", payload)]),
          ),
        ),
        JSON.stringify(payload),
      ).toBe("unresolved_override");
    expect(
      errorCode(() =>
        resolve(
          target,
          [pack],
          state([], [override(pack, "filer", "extend", { role: "counsel" })]),
        ),
      ),
    ).toBe("unresolved_override");
    // A project-owned agent cannot carry capabilities, however it got there.
    expect(
      errorCode(() =>
        resolve(
          target,
          [pack],
          state([
            owned("agents", "helper", {
              id: "helper",
              role: "auditor",
              capabilities: ["file"],
            }),
            owned("roles", "auditor"),
          ]),
        ),
      ),
    ).toBe("configuration_invariant");
  });

  test("a stored list over the bound fails closed; one at the bound resolves", () => {
    const names = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `p${String(index).padStart(4, "0")}`,
      );
    const target = catalog();
    const pack = register(
      target,
      packBytes("1.0.0", {
        prompts: names(1_001).map((id) => ({ id })),
        agents: [{ id: "filer" }],
      }),
    );
    const stored = (count: number) =>
      state(
        [],
        [
          override(pack, "filer", "replace", {
            id: "filer",
            prompts: names(count),
          }),
        ],
      );
    expect(
      resolve(target, [pack], stored(1_000)).agents[0]?.prompts,
    ).toHaveLength(1_000);
    expect(errorCode(() => resolve(target, [pack], stored(1_001)))).toBe(
      "unresolved_override",
    );
    const ownedWith = (count: number) =>
      state([
        owned("agents", "helper", { id: "helper", prompts: names(count) }),
        ...names(count).map((id) => owned("prompts", id)),
      ]);
    expect(
      resolve(catalog(), [], ownedWith(1_000)).agents[0]?.prompts,
    ).toHaveLength(1_000);
    expect(errorCode(() => resolve(catalog(), [], ownedWith(1_001)))).toBe(
      "configuration_invariant",
    );
  });

  test("stored lists are resolved in one order, whatever order they were stored in", () => {
    const target = catalog();
    const pack = register(target, v1);
    const stored = (prompts: string[], capabilities: string[]) =>
      resolve(
        target,
        [pack],
        state(
          [],
          [
            override(pack, "filer", "replace", {
              id: "filer",
              role: "counsel",
              prompts,
              capabilities,
            }),
          ],
        ),
      );
    const ascending = stored(["brief", "tone"], ["draft", "review"]);
    const shuffled = stored(["tone", "brief"], ["review", "draft"]);
    expect(shuffled.agents).toEqual(ascending.agents);
    expect(shuffled.configurationDigest).toBe(ascending.configurationDigest);
  });
});
