import type {
  OfficeManifest,
  OfficeManifestRevision,
} from "@ai-office/domain/office/office-manifest.ts";
import { ProjectNotFoundError } from "../errors.ts";
import type { RecordAuditEvent } from "./record-audit-event.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { OfficeManifestRepository } from "../ports/office-manifest-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";

export class ApplyOfficeManifest {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly manifests: OfficeManifestRepository,
    private readonly audit: RecordAuditEvent,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(
    projectId: string,
    manifest: OfficeManifest,
  ): Promise<OfficeManifestRevision> {
    return this.transactions.run(async () => {
      const project = await this.projects.findById(projectId);
      if (project === null) throw new ProjectNotFoundError(projectId);

      const latest = await this.manifests.findLatest(projectId);
      const revision: OfficeManifestRevision = {
        id: this.ids.generate(),
        projectId,
        revision: (latest?.revision ?? 0) + 1,
        manifest,
        appliedAt: this.clock.now(),
      };
      await this.manifests.save(revision);
      await this.audit.execute({
        eventType: "office.manifest.applied",
        actorType: "cli",
        actorId: manifest.provenance.host,
        aggregateType: "office_manifest_revision",
        aggregateId: revision.id,
        projectId,
        payload: {
          revision: revision.revision,
          schemaVersion: manifest.schemaVersion,
          skill: manifest.provenance.skill,
          skillVersion: manifest.provenance.skillVersion,
          roles: manifest.office.roles.length,
          pipelines: manifest.pipelines.length,
        },
      });
      return revision;
    });
  }
}
