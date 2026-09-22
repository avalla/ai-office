import { describe, expect, test } from "vitest";
import type { OfficeManifestRepository } from "@ai-office/application/ports/office-manifest-repository.port.ts";
import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";
import type { TransactionRunner } from "@ai-office/application/ports/transaction-runner.port.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";

export interface OfficeManifestContractFixture {
  manifests: OfficeManifestRepository;
  projects: ProjectRepository;
  transactions: TransactionRunner;
  close(): Promise<void>;
}

const now = new Date("2026-09-22T00:00:00.000Z");

function manifest(host: string): OfficeManifest {
  return {
    schemaVersion: 1,
    provenance: { host, skill: "ai-office", skillVersion: "1.0.0" },
    project: {
      mission: "Contract mission",
      goals: ["Ship"],
      constraints: [],
      preferences: [],
      permissionPreferences: [],
    },
    office: {
      name: "Contract office",
      roles: [
        {
          id: "developer",
          title: "Developer",
          purpose: "Build",
          responsibilities: ["Build"],
        },
      ],
    },
    pipelines: [
      {
        id: "delivery",
        name: "Delivery",
        description: "Ship safely",
        defaultFor: ["feature"],
        enforcement: "enforced",
        stages: [
          {
            id: "build",
            name: "Build",
            roleId: "developer",
            objective: "Build",
            checks: ["Tests"],
            requiresApproval: false,
            capabilities: ["filesystem.read"],
          },
        ],
      },
    ],
  };
}

async function seedProject(
  fixture: OfficeManifestContractFixture,
  id: string,
): Promise<void> {
  await fixture.projects.save(Project.create({ id, name: id, now }));
}

export function defineOfficeManifestRepositoryContracts(
  create: () => Promise<OfficeManifestContractFixture>,
): void {
  describe("OfficeManifestRepository contract", () => {
    test("saves and finds the latest revision with exact provenance", async () => {
      const fixture = await create();
      try {
        await seedProject(fixture, "manifest-project");
        await fixture.manifests.save({
          id: "manifest-1",
          projectId: "manifest-project",
          revision: 1,
          manifest: manifest("codex"),
          appliedAt: now,
        });
        await fixture.manifests.save({
          id: "manifest-2",
          projectId: "manifest-project",
          revision: 2,
          manifest: manifest("claude"),
          appliedAt: new Date(now.getTime() + 1),
        });

        await expect(
          fixture.manifests.findLatest("manifest-project"),
        ).resolves.toMatchObject({
          id: "manifest-2",
          projectId: "manifest-project",
          revision: 2,
          manifest: expect.objectContaining({
            provenance: {
              host: "claude",
              skill: "ai-office",
              skillVersion: "1.0.0",
            },
          }),
        });
      } finally {
        await fixture.close();
      }
    });

    test("isolates projects and rejects duplicate revision identity", async () => {
      const fixture = await create();
      try {
        await seedProject(fixture, "manifest-project-a");
        await seedProject(fixture, "manifest-project-b");
        await fixture.manifests.save({
          id: "manifest-a",
          projectId: "manifest-project-a",
          revision: 1,
          manifest: manifest("codex"),
          appliedAt: now,
        });
        await fixture.manifests.save({
          id: "manifest-b",
          projectId: "manifest-project-b",
          revision: 1,
          manifest: manifest("claude"),
          appliedAt: now,
        });
        await expect(
          fixture.manifests.findLatest("manifest-project-b"),
        ).resolves.toMatchObject({ id: "manifest-b" });
        await expect(
          fixture.manifests.save({
            id: "manifest-a-duplicate",
            projectId: "manifest-project-a",
            revision: 1,
            manifest: manifest("codex"),
            appliedAt: now,
          }),
        ).rejects.toBeDefined();
      } finally {
        await fixture.close();
      }
    });

    test("rolls back a revision saved inside a failed transaction", async () => {
      const fixture = await create();
      try {
        await seedProject(fixture, "manifest-project");
        await expect(
          fixture.transactions.run(async () => {
            await fixture.manifests.save({
              id: "manifest-rollback",
              projectId: "manifest-project",
              revision: 1,
              manifest: manifest("codex"),
              appliedAt: now,
            });
            throw new Error("rollback");
          }),
        ).rejects.toThrow("rollback");
        await expect(
          fixture.manifests.findLatest("manifest-project"),
        ).resolves.toBeNull();
      } finally {
        await fixture.close();
      }
    });
  });
}
