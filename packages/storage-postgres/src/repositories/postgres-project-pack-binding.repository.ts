import type { PackIdentity } from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import {
  StaleProjectPackBindingError,
  type ProjectPackBinding,
  type ProjectPackBindingRepository,
} from "@ai-office/application/ports/project-pack-binding-repository.port.ts";
import { PostgresClient } from "../database/postgres-client.ts";
import { requirePostgresTenantId } from "../database/postgres-tenant-context.ts";

interface HeadRow extends Record<string, unknown> {
  configuration_revision: number;
}
interface PackRow extends Record<string, unknown> {
  pack_id: PackIdentity["id"];
  pack_version: PackIdentity["version"];
  manifest_digest: PackIdentity["manifestDigest"];
}

export class PostgresProjectPackBindingRepository implements ProjectPackBindingRepository {
  private readonly tenantId: string;
  constructor(
    private readonly database: PostgresClient,
    tenantId: string,
  ) {
    this.tenantId = requirePostgresTenantId(tenantId);
  }

  async get(projectId: string): Promise<ProjectPackBinding> {
    const [head] = await this.database.query<HeadRow>(
      `SELECT configuration_revision FROM core.project_pack_binding
       WHERE project_id = $1 AND tenant_id = $2`,
      [projectId, this.tenantId],
    );
    const rows = await this.database.query<PackRow>(
      `SELECT pack_id, pack_version, manifest_digest FROM core.project_pack_binding_pack
       WHERE project_id = $1 AND tenant_id = $2 ORDER BY pack_id`,
      [projectId, this.tenantId],
    );
    return {
      projectId,
      configurationRevision: head?.configuration_revision ?? 0,
      packs: rows.map((row) => ({
        id: row.pack_id,
        version: row.pack_version,
        manifestDigest: row.manifest_digest,
      })),
    };
  }

  async replace(
    projectId: string,
    expectedRevision: number,
    packs: readonly PackIdentity[],
    changedAt: Date,
  ): Promise<{ binding: ProjectPackBinding; changed: boolean }> {
    return this.database.runInTransaction(async () => {
      await this.database.query(
        `INSERT INTO core.project_pack_binding(project_id, tenant_id)
         SELECT id, tenant_id FROM core.project WHERE id = $1 AND tenant_id = $2
         ON CONFLICT(project_id) DO NOTHING`,
        [projectId, this.tenantId],
      );
      const [head] = await this.database.query<HeadRow>(
        `SELECT configuration_revision FROM core.project_pack_binding
         WHERE project_id = $1 AND tenant_id = $2 FOR UPDATE`,
        [projectId, this.tenantId],
      );
      const current = await this.get(projectId);
      if (!head || head.configuration_revision !== expectedRevision)
        throw new StaleProjectPackBindingError(
          projectId,
          head?.configuration_revision ?? 0,
        );
      const desired = [...packs].sort((a, b) => a.id.localeCompare(b.id));
      if (JSON.stringify(current.packs) === JSON.stringify(desired))
        return { binding: current, changed: false };
      const updated = await this.database.query<{ project_id: string }>(
        `UPDATE core.project_pack_binding SET configuration_revision = configuration_revision + 1,
         changed_at = $3 WHERE project_id = $1 AND tenant_id = $2 AND configuration_revision = $4
         RETURNING project_id`,
        [projectId, this.tenantId, changedAt, expectedRevision],
      );
      if (updated.length !== 1)
        throw new StaleProjectPackBindingError(
          projectId,
          current.configurationRevision,
        );
      await this.database.query(
        `DELETE FROM core.project_pack_binding_pack WHERE project_id = $1 AND tenant_id = $2`,
        [projectId, this.tenantId],
      );
      for (const pack of desired)
        await this.database.query(
          `INSERT INTO core.project_pack_binding_pack(project_id, tenant_id, pack_id, pack_version, manifest_digest)
         VALUES ($1, $2, $3, $4, $5)`,
          [
            projectId,
            this.tenantId,
            pack.id,
            pack.version,
            pack.manifestDigest,
          ],
        );
      return {
        binding: {
          projectId,
          configurationRevision: expectedRevision + 1,
          packs: desired,
        },
        changed: true,
      };
    });
  }
}
