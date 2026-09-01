import type { Database } from "bun:sqlite";
import type {
  ProjectStateHead,
  ProjectStateRepository,
  ProjectStateRevision,
} from "@ai-office/application/ports/project-state-repository.port.ts";
import {
  portableProjectStateSchema,
  type PortableProjectState,
} from "@ai-office/application/project-portability/project-snapshot.ts";

interface ProjectRow {
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: PortableProjectState["tasks"][number]["status"];
  priority: number;
  created_at: string;
  updated_at: string;
}

interface ProfileRow {
  id: string;
  category: string;
  key: string;
  value_json: string;
  origin: PortableProjectState["profileEntries"][number]["origin"];
  confidence: number;
  confirmed_at: string | null;
  created_at: string;
}

interface ManifestRow {
  id: string;
  revision: number;
  manifest_json: string;
  applied_at: string;
}

interface MilestoneRow {
  id: string;
  title: string;
  description: string | null;
  status: PortableProjectState["governance"]["milestones"][number]["status"];
  created_at: string;
  updated_at: string;
}

interface RequirementRow {
  id: string;
  milestone_id: string | null;
  requirement_key: string;
  title: string;
  description: string;
  status: PortableProjectState["governance"]["requirements"][number]["status"];
  created_at: string;
  updated_at: string;
}

interface AdrRow {
  id: string;
  title: string;
  context: string;
  decision: string;
  consequences: string;
  status: PortableProjectState["governance"]["adrs"][number]["status"];
  superseded_by_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ReviewRow {
  id: string;
  subject_type: PortableProjectState["governance"]["reviews"][number]["subjectType"];
  subject_id: string;
  reviewer_actor_type: "user" | "agent" | "system";
  reviewer_actor_id: string;
  reviewer_display_name: string | null;
  status: PortableProjectState["governance"]["reviews"][number]["status"];
  summary: string | null;
  created_at: string;
  completed_at: string | null;
}

interface ApprovalRow {
  id: string;
  review_id: string;
  decision: "approved" | "rejected";
  actor_type: "user" | "agent" | "system";
  actor_id: string;
  display_name: string | null;
  rationale: string | null;
  created_at: string;
}

interface RoleRow {
  id: string;
  role_key: string;
  name: string;
  version: number;
  capabilities_json: string;
  tools_json: string;
  model_policy: string;
  limits_json: string;
  created_at: string;
  updated_at: string;
}

interface AgentRow {
  id: string;
  role_id: string;
  name: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  task_id: string;
  agent_id: string;
  status: "completed" | "failed" | "cancelled";
  created_at: string;
  started_at: string | null;
  completed_at: string;
  updated_at: string;
}

interface HeadRow {
  id: string;
  project_id: string;
  parent_revision_id: string | null;
  state_checksum: string;
  origin: ProjectStateRevision["origin"];
  created_at: string;
  base_revision_id: string | null;
}

interface RevisionRow {
  project_id: string;
  parent_revision_id: string | null;
  state_checksum: string;
}

function optional<T>(key: string, value: T | null): Record<string, T> {
  return value === null ? {} : { [key]: value };
}

export class SqliteProjectStateRepository implements ProjectStateRepository {
  constructor(private readonly database: Database) {}

  async loadPortableState(projectId: string): Promise<PortableProjectState> {
    const project = this.database
      .query<ProjectRow, [string]>(
        `SELECT name, description, created_at, updated_at
         FROM project WHERE id = ?`,
      )
      .get(projectId);
    if (project === null)
      throw new Error(`Project ${projectId} does not exist`);
    const portableDescription =
      project.description?.startsWith("Imported from ") === true
        ? null
        : project.description;

    const tasks = this.database
      .query<TaskRow, [string]>(
        `SELECT id, title, description, status, priority, created_at, updated_at
         FROM task WHERE project_id = ? ORDER BY created_at, id`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id,
        title: row.title,
        ...optional("description", row.description),
        status: row.status,
        priority: row.priority,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    const profileEntries = this.database
      .query<ProfileRow, [string]>(
        `SELECT id, category, key, value_json, origin, confidence,
                confirmed_at, created_at
         FROM project_profile_entry
         WHERE project_id = ? AND superseded_at IS NULL
           AND NOT (
             category = 'repository'
             AND key IN ('root_path', 'remote_url')
           )
         ORDER BY category, key, created_at, id`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id,
        category: row.category,
        key: row.key,
        value: JSON.parse(row.value_json) as unknown,
        origin: row.origin,
        confidence: row.confidence,
        ...optional("confirmedAt", row.confirmed_at),
        createdAt: row.created_at,
      }));
    const officeManifests = this.database
      .query<ManifestRow, [string]>(
        `SELECT id, revision, manifest_json, applied_at
         FROM office_manifest_revision
         WHERE project_id = ? ORDER BY revision, id`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id,
        revision: row.revision,
        manifest: JSON.parse(row.manifest_json) as unknown,
        appliedAt: row.applied_at,
      }));
    const milestones = this.database
      .query<MilestoneRow, [string]>(
        `SELECT id, title, description, status, created_at, updated_at
         FROM milestone WHERE project_id = ? ORDER BY created_at, id`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id,
        title: row.title,
        ...optional("description", row.description),
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    const requirements = this.database
      .query<RequirementRow, [string]>(
        `SELECT id, milestone_id, requirement_key, title, description, status,
                created_at, updated_at
         FROM requirement WHERE project_id = ? ORDER BY requirement_key, id`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id,
        ...optional("milestoneId", row.milestone_id),
        key: row.requirement_key,
        title: row.title,
        description: row.description,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    const adrs = this.database
      .query<AdrRow, [string]>(
        `SELECT id, title, context, decision, consequences, status,
                superseded_by_id, created_at, updated_at
         FROM architecture_decision
         WHERE project_id = ? ORDER BY created_at, id`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id,
        title: row.title,
        context: row.context,
        decision: row.decision,
        consequences: row.consequences,
        status: row.status,
        ...optional("supersededById", row.superseded_by_id),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    const reviews = this.database
      .query<ReviewRow, [string]>(
        `SELECT id, subject_type, subject_id, reviewer_actor_type,
                reviewer_actor_id, reviewer_display_name, status, summary,
                created_at, completed_at
         FROM review WHERE project_id = ? ORDER BY created_at, id`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        reviewer: {
          type: row.reviewer_actor_type,
          id: row.reviewer_actor_id,
          ...optional("displayName", row.reviewer_display_name),
        },
        status: row.status,
        ...optional("summary", row.summary),
        createdAt: row.created_at,
        ...optional("completedAt", row.completed_at),
      }));
    const approvals = this.database
      .query<ApprovalRow, [string]>(
        `SELECT id, review_id, decision, actor_type, actor_id, display_name,
                rationale, created_at
         FROM approval WHERE project_id = ? ORDER BY created_at, id`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id,
        reviewId: row.review_id,
        decision: row.decision,
        actor: {
          type: row.actor_type,
          id: row.actor_id,
          ...optional("displayName", row.display_name),
        },
        ...optional("rationale", row.rationale),
        createdAt: row.created_at,
      }));
    const roles = this.database
      .query<RoleRow, [string]>(
        `SELECT id, role_key, name, version, capabilities_json, tools_json,
                model_policy, limits_json, created_at, updated_at
         FROM role WHERE project_id = ? ORDER BY role_key, id`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id,
        key: row.role_key,
        name: row.name,
        version: row.version,
        capabilities: JSON.parse(row.capabilities_json) as unknown,
        tools: JSON.parse(row.tools_json) as unknown,
        modelPolicy: row.model_policy,
        limits: JSON.parse(row.limits_json) as unknown,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    const definitions = this.database
      .query<AgentRow, [string]>(
        `SELECT id, role_id, name, enabled, created_at, updated_at
         FROM agent WHERE project_id = ? ORDER BY name, id`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id,
        roleId: row.role_id,
        name: row.name,
        enabled: row.enabled === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    const terminalRuns = this.database
      .query<RunRow, [string]>(
        `SELECT id, task_id, agent_id, status, created_at, started_at,
                completed_at, updated_at
         FROM agent_run
         WHERE project_id = ? AND status IN ('completed', 'failed', 'cancelled')
         ORDER BY created_at, id`,
      )
      .all(projectId)
      .map((row) => ({
        id: row.id,
        taskId: row.task_id,
        agentId: row.agent_id,
        status: row.status,
        createdAt: row.created_at,
        ...optional("startedAt", row.started_at),
        completedAt: row.completed_at,
        updatedAt: row.updated_at,
      }));

    return portableProjectStateSchema.parse({
      project: {
        name: project.name,
        ...optional("description", portableDescription),
        createdAt: project.created_at,
        updatedAt: project.updated_at,
      },
      tasks,
      profileEntries,
      officeManifests,
      governance: { milestones, requirements, adrs, reviews, approvals },
      agents: { roles, definitions, terminalRuns },
    });
  }

  async restorePortableState(
    projectId: string,
    state: PortableProjectState,
  ): Promise<void> {
    const value = portableProjectStateSchema.parse(state);
    for (const item of value.tasks)
      this.database
        .prepare(
          `INSERT INTO task(id, project_id, title, description, status, priority,
                            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.id,
          projectId,
          item.title,
          item.description ?? null,
          item.status,
          item.priority,
          item.createdAt,
          item.updatedAt,
        );
    for (const item of value.profileEntries)
      this.database
        .prepare(
          `INSERT INTO project_profile_entry(
             id, project_id, category, key, value_json, origin, confidence,
             source_reference, confirmed_at, superseded_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
        )
        .run(
          item.id,
          projectId,
          item.category,
          item.key,
          JSON.stringify(item.value),
          item.origin,
          item.confidence,
          item.confirmedAt ?? null,
          item.createdAt,
        );
    for (const item of value.officeManifests)
      this.database
        .prepare(
          `INSERT INTO office_manifest_revision(
             id, project_id, revision, schema_version, manifest_json,
             source_host, source_skill, source_skill_version, applied_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.id,
          projectId,
          item.revision,
          item.manifest.schemaVersion,
          JSON.stringify(item.manifest),
          item.manifest.provenance.host,
          item.manifest.provenance.skill,
          item.manifest.provenance.skillVersion,
          item.appliedAt,
        );
    for (const item of value.governance.milestones)
      this.database
        .prepare(
          `INSERT INTO milestone(id, project_id, title, description, status,
                                 created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.id,
          projectId,
          item.title,
          item.description ?? null,
          item.status,
          item.createdAt,
          item.updatedAt,
        );
    for (const item of value.governance.requirements)
      this.database
        .prepare(
          `INSERT INTO requirement(
             id, project_id, milestone_id, requirement_key, title, description,
             status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.id,
          projectId,
          item.milestoneId ?? null,
          item.key,
          item.title,
          item.description,
          item.status,
          item.createdAt,
          item.updatedAt,
        );
    for (const item of value.governance.adrs)
      this.database
        .prepare(
          `INSERT INTO architecture_decision(
             id, project_id, title, context, decision, consequences, status,
             superseded_by_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          item.id,
          projectId,
          item.title,
          item.context,
          item.decision,
          item.consequences,
          item.status,
          item.createdAt,
          item.updatedAt,
        );
    for (const item of value.governance.adrs) {
      if (item.supersededById !== undefined)
        this.database
          .prepare(
            `UPDATE architecture_decision SET superseded_by_id = ?
             WHERE id = ? AND project_id = ?`,
          )
          .run(item.supersededById, item.id, projectId);
    }
    for (const item of value.agents.roles)
      this.database
        .prepare(
          `INSERT INTO role(
             id, project_id, role_key, name, version, capabilities_json,
             tools_json, model_policy, limits_json, source_path, created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.id,
          projectId,
          item.key,
          item.name,
          item.version,
          JSON.stringify(item.capabilities),
          JSON.stringify(item.tools),
          item.modelPolicy,
          JSON.stringify(item.limits),
          `portable://role/${encodeURIComponent(item.key)}`,
          item.createdAt,
          item.updatedAt,
        );
    for (const item of value.agents.definitions)
      this.database
        .prepare(
          `INSERT INTO agent(id, project_id, role_id, name, enabled, created_at,
                             updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.id,
          projectId,
          item.roleId,
          item.name,
          item.enabled ? 1 : 0,
          item.createdAt,
          item.updatedAt,
        );
    for (const item of value.agents.terminalRuns)
      this.database
        .prepare(
          `INSERT INTO agent_run(
             id, project_id, task_id, agent_id, action_intent_json,
             pipeline_run_id, status, worktree_path, result_json, error_json,
             created_at, started_at, completed_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
        )
        .run(
          item.id,
          projectId,
          item.taskId,
          item.agentId,
          item.status,
          item.createdAt,
          item.startedAt ?? null,
          item.completedAt,
          item.updatedAt,
        );
    for (const item of value.governance.reviews)
      this.database
        .prepare(
          `INSERT INTO review(
             id, project_id, subject_type, subject_id, reviewer_actor_type,
             reviewer_actor_id, reviewer_display_name, status, summary,
             created_at, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.id,
          projectId,
          item.subjectType,
          item.subjectId,
          item.reviewer.type,
          item.reviewer.id,
          item.reviewer.displayName ?? null,
          item.status,
          item.summary ?? null,
          item.createdAt,
          item.completedAt ?? null,
        );
    for (const item of value.governance.approvals)
      this.database
        .prepare(
          `INSERT INTO approval(
             id, project_id, review_id, decision, actor_type, actor_id,
             display_name, rationale, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.id,
          projectId,
          item.reviewId,
          item.decision,
          item.actor.type,
          item.actor.id,
          item.actor.displayName ?? null,
          item.rationale ?? null,
          item.createdAt,
        );
  }

  async findHead(projectId: string): Promise<ProjectStateHead | null> {
    const row = this.database
      .query<HeadRow, [string]>(
        `SELECT revision.id, revision.project_id, revision.parent_revision_id,
                revision.state_checksum, revision.origin, revision.created_at,
                head.base_revision_id
         FROM project_state_head head
         JOIN project_state_revision revision
           ON revision.project_id = head.project_id
          AND revision.id = head.revision_id
         WHERE head.project_id = ?`,
      )
      .get(projectId);
    if (row === null) return null;
    return {
      revision: {
        id: row.id,
        projectId: row.project_id,
        ...optional("parentRevisionId", row.parent_revision_id),
        stateChecksum: row.state_checksum,
        origin: row.origin,
        createdAt: new Date(row.created_at),
      },
      ...optional("baseRevisionId", row.base_revision_id),
    };
  }

  async saveRevision(
    revision: ProjectStateRevision,
    baseRevisionId?: string,
  ): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO project_state_revision(
           id, project_id, parent_revision_id, state_checksum, origin, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        revision.id,
        revision.projectId,
        revision.parentRevisionId ?? null,
        revision.stateChecksum,
        revision.origin,
        revision.createdAt.toISOString(),
      );
    const stored = this.database
      .query<RevisionRow, [string]>(
        `SELECT project_id, parent_revision_id, state_checksum
         FROM project_state_revision WHERE id = ?`,
      )
      .get(revision.id);
    if (
      stored === null ||
      stored.project_id !== revision.projectId ||
      stored.parent_revision_id !== (revision.parentRevisionId ?? null) ||
      stored.state_checksum !== revision.stateChecksum
    )
      throw new Error(`Project state revision ${revision.id} conflicts`);
    this.database
      .prepare(
        `INSERT INTO project_state_head(
           project_id, revision_id, base_revision_id, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           revision_id = excluded.revision_id,
           base_revision_id = excluded.base_revision_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        revision.projectId,
        revision.id,
        baseRevisionId ?? null,
        revision.createdAt.toISOString(),
      );
  }
}
