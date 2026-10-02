import type { Database } from "bun:sqlite";
import type { PackIdentity } from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import {
  StaleProjectPackBindingError,
  type ProjectPackBinding,
  type ProjectPackBindingRepository,
} from "@ai-office/application/ports/project-pack-binding-repository.port.ts";

interface HeadRow {
  configuration_revision: number;
}
interface PackRow {
  pack_id: PackIdentity["id"];
  pack_version: PackIdentity["version"];
  manifest_digest: PackIdentity["manifestDigest"];
}

export class SqliteProjectPackBindingRepository implements ProjectPackBindingRepository {
  constructor(private readonly database: Database) {}

  async get(projectId: string): Promise<ProjectPackBinding> {
    const head = this.database
      .query<HeadRow, [string]>(
        "SELECT configuration_revision FROM project_pack_binding WHERE project_id = ?",
      )
      .get(projectId);
    const packs = this.database
      .query<PackRow, [string]>(
        `SELECT pack_id, pack_version, manifest_digest FROM project_pack_binding_pack
       WHERE project_id = ? ORDER BY pack_id`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.pack_id,
        version: row.pack_version,
        manifestDigest: row.manifest_digest,
      }));
    return {
      projectId,
      configurationRevision: head?.configuration_revision ?? 0,
      packs,
    };
  }

  async replace(
    projectId: string,
    expectedRevision: number,
    packs: readonly PackIdentity[],
    changedAt: Date,
  ): Promise<{ binding: ProjectPackBinding; changed: boolean }> {
    this.database.exec("SAVEPOINT project_pack_binding_replace");
    try {
      this.database
        .query(
          `INSERT OR IGNORE INTO project_pack_binding(project_id, configuration_revision)
         SELECT id, 0 FROM project WHERE id = ?`,
        )
        .run(projectId);
      const current = await this.get(projectId);
      if (current.configurationRevision !== expectedRevision)
        throw new StaleProjectPackBindingError(
          projectId,
          current.configurationRevision,
        );
      const desired = [...packs].sort((a, b) => a.id.localeCompare(b.id));
      if (JSON.stringify(current.packs) === JSON.stringify(desired)) {
        this.database.exec("RELEASE SAVEPOINT project_pack_binding_replace");
        return { binding: current, changed: false };
      }
      const update = this.database
        .query(
          `UPDATE project_pack_binding SET configuration_revision = configuration_revision + 1,
         changed_at = ? WHERE project_id = ? AND configuration_revision = ?`,
        )
        .run(changedAt.toISOString(), projectId, expectedRevision);
      if (update.changes !== 1)
        throw new StaleProjectPackBindingError(
          projectId,
          (await this.get(projectId)).configurationRevision,
        );
      this.database
        .query("DELETE FROM project_pack_binding_pack WHERE project_id = ?")
        .run(projectId);
      const insert = this.database.query(
        `INSERT INTO project_pack_binding_pack(project_id, pack_id, pack_version, manifest_digest)
         VALUES (?, ?, ?, ?)`,
      );
      for (const pack of desired)
        insert.run(projectId, pack.id, pack.version, pack.manifestDigest);
      const binding = {
        projectId,
        configurationRevision: expectedRevision + 1,
        packs: desired,
      };
      this.database.exec("RELEASE SAVEPOINT project_pack_binding_replace");
      return { binding, changed: true };
    } catch (error) {
      this.database.exec("ROLLBACK TO SAVEPOINT project_pack_binding_replace");
      this.database.exec("RELEASE SAVEPOINT project_pack_binding_replace");
      throw error;
    }
  }
}
