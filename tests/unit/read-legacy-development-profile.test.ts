import { describe, expect, test } from "vitest";
import { LegacyDevelopmentProfileError } from "@ai-office/application/domain-pack/legacy-development-profile.ts";
import { ReadLegacyDevelopmentProfile } from "@ai-office/application/domain-pack/read-legacy-development-profile.ts";
import type { ProjectPackBinding } from "@ai-office/application/ports/project-pack-binding-repository.port.ts";
import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";
import type { Agent } from "@ai-office/domain/agent/agent.ts";
import { Role, type RoleProps } from "@ai-office/domain/agent/role.ts";
import type { OfficeManifestRevision } from "@ai-office/domain/office/office-manifest.ts";
import { legacyProfileInput } from "../helpers/legacy-development-fixture.ts";

// GP-09 reader. A PostgreSQL transaction is read committed, so each read sees
// what is committed when it runs. These stores commit a change at a chosen
// point between the reads; the reader must never derive a profile from a mix.

const fixtureDigest =
  "sha256:96ad6eab62fd50dd9290df6c3c2f471604b9290cc7fb5ee2e4c13ba3c9002efa";
const projectId = "project-a";
const seededAt = new Date("2026-09-01T00:00:00.000Z");
const changedAt = new Date("2026-09-02T00:00:00.000Z");

type Source = "office" | "roles" | "agents" | "binding";

interface Committed {
  office: OfficeManifestRevision | null;
  roles: RoleProps[];
  agents: Agent[];
  binding: ProjectPackBinding;
}

/** A change committed right after the given read of one source returns. */
interface Commit {
  readonly after: Source;
  readonly read: 1 | 2;
  readonly change: (state: Committed) => void;
}

function committedFixture(): Committed {
  const input = legacyProfileInput();
  return {
    office: {
      id: "office-revision-1",
      projectId,
      revision: input.office!.revision,
      manifest: input.office!.manifest,
      appliedAt: seededAt,
    },
    roles: input.roles.map((role) => ({
      ...role,
      projectId,
      sourcePath: `agents/${role.key}/agent.yaml`,
      createdAt: seededAt,
      updatedAt: seededAt,
    })),
    agents: input.agents.map((agent) => ({
      ...agent,
      id: `agent:${agent.name}`,
      projectId,
      createdAt: seededAt,
      updatedAt: seededAt,
    })),
    binding: { projectId, configurationRevision: 0, packs: [] },
  };
}

function service(commits: readonly Commit[]) {
  const state = committedFixture();
  const reads: Source[] = [];
  const observed = <T>(source: Source, value: T): T => {
    reads.push(source);
    const count = reads.filter((item) => item === source).length;
    for (const commit of commits)
      if (commit.after === source && commit.read === count)
        commit.change(state);
    return value;
  };
  const reader = new ReadLegacyDevelopmentProfile({
    projects: {
      findById: async () => ({ id: projectId }),
    } as unknown as ProjectRepository,
    officeManifests: {
      findLatest: async () => observed("office", state.office),
    },
    runtime: {
      listRoles: async () =>
        observed(
          "roles",
          state.roles.map((role) => Role.restore(structuredClone(role))),
        ),
      listAgents: async () => observed("agents", structuredClone(state.agents)),
    },
    bindings: { get: async () => observed("binding", state.binding) },
    transactions: { run: async (work) => work() },
  });
  return { reader, reads, state };
}

/** `agent:sync` committing a new role together with its agent. */
const syncAddsRoleAndAgent = (state: Committed) => {
  state.roles.push({
    ...state.roles[0]!,
    id: "role:late",
    key: "late",
    createdAt: changedAt,
    updatedAt: changedAt,
  });
  state.agents.push({
    id: "agent:late",
    projectId,
    name: "late",
    roleId: "role:late",
    enabled: true,
    createdAt: changedAt,
    updatedAt: changedAt,
  });
};

/** `office:apply` committing the next revision, one pipeline shorter. */
const officeApplyDropsAPipeline = (state: Committed) => {
  const current = state.office!;
  state.office = {
    ...current,
    id: "office-revision-2",
    revision: current.revision + 1,
    manifest: {
      ...current.manifest,
      pipelines: current.manifest.pipelines.slice(1),
    },
    appliedAt: changedAt,
  };
};

const disableOneAgent = (state: Committed) => {
  state.agents[0] = {
    ...state.agents[0]!,
    enabled: false,
    updatedAt: changedAt,
  };
};

const editOneRole = (state: Committed) => {
  state.roles[0] = {
    ...state.roles[0]!,
    tools: [...state.roles[0]!.tools, "project.search"],
    updatedAt: changedAt,
  };
};

const bindAPack = (state: Committed) => {
  state.binding = { ...state.binding, configurationRevision: 1 };
};

describe("GP-09 legacy development profile reader", () => {
  test("an unchanged project is read twice per source and gives the pinned profile", async () => {
    const { reader, reads } = service([]);
    const profile = await reader.read(projectId);
    expect(profile.profileDigest).toBe(fixtureDigest);
    expect(reads).toEqual([
      "office",
      "roles",
      "agents",
      "binding",
      "office",
      "roles",
      "agents",
      "binding",
    ]);
  });

  test.each([
    [
      "agent:sync commits a role and its agent between the role and agent reads",
      { after: "roles", read: 1, change: syncAddsRoleAndAgent },
    ],
    [
      "office:apply commits a revision after the office was read",
      { after: "office", read: 1, change: officeApplyDropsAPipeline },
    ],
    [
      "a role changes after the roles were read",
      { after: "agents", read: 1, change: editOneRole },
    ],
    [
      "an agent is disabled after the agents were read",
      { after: "binding", read: 1, change: disableOneAgent },
    ],
    [
      "the pack binding changes after it was read",
      { after: "binding", read: 1, change: bindAPack },
    ],
    [
      "a role changes while the confirming reads run",
      { after: "office", read: 2, change: editOneRole },
    ],
  ] as const)(
    "fails with stale_legacy_state when %s",
    async (_name, commit) => {
      const { reader } = service([commit]);
      const error: unknown = await reader
        .read(projectId)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LegacyDevelopmentProfileError);
      expect(error).toMatchObject({
        code: "stale_legacy_state",
        message: "Legacy state changed during the read; run the command again",
      });
    },
  );

  test("a change committed after a source's confirming read leaves the profile of the earlier state", async () => {
    // Every source was read unchanged on both sides of one instant, so the
    // profile is of the state at that instant; the later commit is not in it.
    const { reader, state } = service([
      { after: "binding", read: 2, change: officeApplyDropsAPipeline },
    ]);
    const profile = await reader.read(projectId);
    expect(profile.profileDigest).toBe(fixtureDigest);
    expect(profile.metadata.officeManifestRevision).toBe(1);
    expect(state.office!.revision).toBe(2);
  });

  test("the next read after a stale one gives the profile of the new state", async () => {
    const { reader } = service([
      { after: "roles", read: 1, change: syncAddsRoleAndAgent },
    ]);
    await expect(reader.read(projectId)).rejects.toMatchObject({
      code: "stale_legacy_state",
    });
    const profile = await reader.read(projectId);
    expect(profile.runtimeOnly.agents.map((agent) => agent.name)).toContain(
      "late",
    );
    expect(profile.profileDigest).not.toBe(fixtureDigest);
  });
});
