import { Database } from "bun:sqlite";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadedAgentDefinition } from "@ai-office/agent-runtime/yaml-agent-definition-loader.ts";
import { ApplyOfficeManifest } from "@ai-office/application/commands/apply-office-manifest.ts";
import { ManageGovernance } from "@ai-office/application/commands/manage-governance.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { ScheduleAgentRun } from "@ai-office/application/commands/schedule-agent-run.ts";
import { SyncAgentDefinitions } from "@ai-office/application/commands/sync-agent-definitions.ts";
import type { LegacyDevelopmentProfileInput } from "@ai-office/application/domain-pack/legacy-development-profile.ts";
import { parseOfficeManifestJson } from "@ai-office/application/office/office-manifest-schema.ts";
import { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import { localOperatorPrincipal } from "@ai-office/application/ports/execution-principal.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { ManageProjectPortability } from "@ai-office/application/project-portability/manage-project-portability.ts";
import {
  createPortableProjectArchive,
  portableProjectManifestFor,
  portableStateAtFormatVersion,
  portableStateChecksum,
  serializePortableProjectArchive,
} from "@ai-office/application/project-portability/project-snapshot.ts";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import { LocalProjectBindingAdapter } from "@ai-office/runtime-host/local-project-binding-adapter.ts";
import { LocalProjectScanner } from "@ai-office/runtime-host/local-project-scanner.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { SqliteGovernanceRepository } from "@ai-office/storage-sqlite/repositories/sqlite-governance.repository.ts";
import { SqliteOfficeManifestRepository } from "@ai-office/storage-sqlite/repositories/sqlite-office-manifest.repository.ts";
import { SqlitePipelineRunRepository } from "@ai-office/storage-sqlite/repositories/sqlite-pipeline-run.repository.ts";
import { SqliteProjectProfileRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-profile.repository.ts";
import { SqliteProjectStateRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-state.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteRepositoryIdentityRepository } from "@ai-office/storage-sqlite/repositories/sqlite-repository-identity.repository.ts";
import { SqliteTaskDependencyRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task-dependency.repository.ts";
import { SqliteTaskRequirementRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task-requirement.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";

/**
 * GP-09 legacy fixture. Everything here is deterministic: a fixed clock that
 * advances one second per reading, sequential IDs, and the committed inputs in
 * `tests/fixtures/legacy-development/`. The committed outputs are rebuilt by
 * `tests/fixtures/legacy-development/regenerate.ts` and checked against these
 * builders by `tests/integration/legacy-development-fixture.test.ts`.
 */
const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const legacyFixtureDirectory = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "legacy-development",
);
export const projectMigrations = join(repositoryRoot, "migrations", "project");
/** The last project migration before any Domain Pack table (GP-05 is 0041). */
export const lastPrePackMigration = "0040_task_execution_history.sql";
export const legacyProjectId = "legacy-project";
export const legacyRepositoryId = "repo_legacy-development-fixture";
export const legacyArchiveFormats = [1, 2, 3, 4] as const;
export type LegacyArchiveFormat = (typeof legacyArchiveFormats)[number];

export function legacyFixturePath(name: string): string {
  return join(legacyFixtureDirectory, name);
}

/** A committed expected profile, as the JSON value a command prints. */
export function legacyExpectedProfile(
  name: "expected-profile.json" | "expected-restored-profile.json",
): unknown {
  return JSON.parse(readFileSync(legacyFixturePath(name), "utf8")) as unknown;
}

export function legacyOfficeManifest(): OfficeManifest {
  return parseOfficeManifestJson(
    readFileSync(legacyFixturePath("office-manifest.json"), "utf8"),
  );
}

interface RuntimeDefinitionsFile {
  readonly agents: readonly {
    readonly id: string;
    readonly roleKey: string;
    readonly role: string;
    readonly version: number;
    readonly capabilities: string[];
    readonly tools: string[];
    readonly modelPolicy: string;
    readonly roleGuidance: string;
    readonly limits: {
      readonly maxIterations: number;
      readonly maxCostMicros: string;
      readonly timeoutSeconds: number;
    };
  }[];
  /** Roles that no agent uses. */
  readonly rolesWithoutAgent: RuntimeDefinitionsFile["agents"];
}

function runtimeDefinitions(): RuntimeDefinitionsFile {
  return JSON.parse(
    readFileSync(legacyFixturePath("runtime-definitions.json"), "utf8"),
  ) as RuntimeDefinitionsFile;
}

function loaded(
  item: RuntimeDefinitionsFile["agents"][number],
): LoadedAgentDefinition {
  return {
    sourcePath: `agents/${item.id}/agent.yaml`,
    definition: {
      ...item,
      capabilities: [...item.capabilities],
      tools: [...item.tools],
      limits: {
        ...item.limits,
        maxCostMicros: BigInt(item.limits.maxCostMicros),
      },
    },
  };
}

export function legacyAgentDefinitions(): LoadedAgentDefinition[] {
  return runtimeDefinitions().agents.map(loaded);
}

export function legacyRolesWithoutAgent(): LoadedAgentDefinition[] {
  return runtimeDefinitions().rolesWithoutAgent.map(loaded);
}

/** The committed legacy office as the pure derivation's input, no storage. */
export function legacyProfileInput(): LegacyDevelopmentProfileInput {
  const role = (item: LoadedAgentDefinition) => ({
    id: `role:${item.definition.roleKey}`,
    key: item.definition.roleKey,
    name: item.definition.role,
    version: item.definition.version,
    capabilities: item.definition.capabilities,
    tools: item.definition.tools,
    modelPolicy: item.definition.modelPolicy,
    limits: item.definition.limits,
    guidanceText: item.definition.roleGuidance,
    guidanceVersion: item.definition.version,
  });
  const agents = legacyAgentDefinitions();
  return {
    office: { revision: 1, manifest: legacyOfficeManifest() },
    roles: [...agents, ...legacyRolesWithoutAgent()].map(role),
    agents: agents.map((item) => ({
      name: item.definition.id,
      roleId: `role:${item.definition.roleKey}`,
      enabled: true,
    })),
    packBindingPresent: false,
  };
}

/**
 * The same office as a portable archive restores it: portable role rows carry
 * no guidance, so every role comes back without one.
 */
export function legacyRestoredProfileInput(): LegacyDevelopmentProfileInput {
  const input = legacyProfileInput();
  return {
    ...input,
    roles: input.roles.map(
      ({ guidanceText: _text, guidanceVersion: _version, ...role }) => role,
    ),
  };
}

export class TickingClock implements Clock {
  private next: number;
  constructor(start = "2026-09-01T00:00:00.000Z") {
    this.next = new Date(start).getTime();
  }
  now(): Date {
    const value = new Date(this.next);
    this.next += 1000;
    return value;
  }
}

export class SequenceIds implements IdGenerator {
  private next = 0;
  constructor(private readonly prefix = "legacy-id") {}
  generate(): string {
    this.next += 1;
    return `${this.prefix}-${String(this.next).padStart(4, "0")}`;
  }
}

class ExactRootBindingAdapter extends LocalProjectBindingAdapter {
  override async resolveProjectRoot(inputPath: string): Promise<string> {
    // Fixture roots are standalone even under an unrelated ancestor `.git`.
    return realpathSync(inputPath);
  }
}

export function legacyStores(
  database: Database,
  clock: Clock = new TickingClock(),
  ids: IdGenerator = new SequenceIds(),
) {
  const projects = new SqliteProjectRepository(database);
  const tasks = new SqliteTaskRepository(database);
  const officeManifests = new SqliteOfficeManifestRepository(database);
  const runtime = new SqliteAgentRuntimeRepository(database);
  const pipelines = new SqlitePipelineRunRepository(database);
  const governance = new SqliteGovernanceRepository(database);
  const identities = new SqliteRepositoryIdentityRepository(database);
  const profiles = new SqliteProjectProfileRepository(database);
  const transactions = new SqliteTransactionRunner(database);
  const audit = new RecordAuditEvent(
    new SqliteAuditEventRepository(database),
    ids,
    clock,
  );
  return {
    database,
    clock,
    ids,
    projects,
    tasks,
    officeManifests,
    runtime,
    pipelines,
    governance,
    identities,
    profiles,
    transactions,
    audit,
    pipelineRuns: new ManagePipelineRuns(
      officeManifests,
      pipelines,
      tasks,
      runtime,
      audit,
      ids,
      clock,
      transactions,
    ),
    scheduling: new ScheduleAgentRun(
      projects,
      tasks,
      runtime,
      ids,
      clock,
      transactions,
      pipelines,
    ),
  };
}

export type LegacyStores = ReturnType<typeof legacyStores>;

export function legacyAgentId(name: string, projectId = legacyProjectId) {
  return `agent:${projectId}:${name}`;
}

/** Project, portable identity, office revision 1, synced roles and agents. */
async function seedOffice(stores: LegacyStores): Promise<void> {
  await stores.projects.save(
    Project.create({
      id: legacyProjectId,
      name: "Legacy development project",
      now: stores.clock.now(),
    }),
  );
  await stores.identities.associate({
    repositoryId: legacyRepositoryId,
    projectId: legacyProjectId,
    createdAt: stores.clock.now(),
  });
  await new ApplyOfficeManifest(
    stores.projects,
    stores.officeManifests,
    stores.audit,
    stores.ids,
    stores.clock,
    stores.transactions,
  ).execute(legacyProjectId, legacyOfficeManifest());
  await new SyncAgentDefinitions(
    stores.projects,
    stores.runtime,
    stores.ids,
    stores.clock,
    stores.transactions,
  ).execute(legacyProjectId, legacyAgentDefinitions());
  for (const item of legacyRolesWithoutAgent())
    await stores.runtime.saveRole(
      Role.create({
        id: `role:${legacyProjectId}:${item.definition.roleKey}`,
        projectId: legacyProjectId,
        key: item.definition.roleKey,
        name: item.definition.role,
        version: item.definition.version,
        capabilities: item.definition.capabilities,
        tools: item.definition.tools,
        modelPolicy: item.definition.modelPolicy,
        limits: item.definition.limits,
        sourcePath: item.sourcePath,
        guidanceText: item.definition.roleGuidance,
        guidanceVersion: item.definition.version,
        now: stores.clock.now(),
      }),
    );
}

async function createTask(stores: LegacyStores, id: string, title: string) {
  await stores.tasks.save(
    Task.create({
      id,
      projectId: legacyProjectId,
      title,
      now: stores.clock.now(),
    }),
  );
}

/** Milestone, requirement, an approved and a rejected review. */
async function seedGovernance(stores: LegacyStores) {
  const governance = new ManageGovernance(
    stores.projects,
    stores.governance,
    stores.ids,
    stores.clock,
  );
  const milestoneId = await governance.createMilestone({
    projectId: legacyProjectId,
    title: "Legacy milestone",
  });
  const requirementId = await governance.createRequirement({
    projectId: legacyProjectId,
    milestoneId,
    key: "LEG-1",
    title: "Legacy requirement",
    description: "Existing projects keep working.",
  });
  const approved = await governance.createReview({
    projectId: legacyProjectId,
    subjectType: "requirement",
    subjectId: requirementId,
    reviewer: { type: "agent", id: "reviewer" },
  });
  await governance.approve({
    projectId: legacyProjectId,
    reviewId: approved,
    actor: { type: "user", id: "owner" },
    decision: "approved",
    rationale: "Accepted",
  });
  const rejected = await governance.createReview({
    projectId: legacyProjectId,
    subjectType: "milestone",
    subjectId: milestoneId,
    reviewer: { type: "agent", id: "reviewer" },
  });
  await governance.approve({
    projectId: legacyProjectId,
    reviewId: rejected,
    actor: { type: "user", id: "owner" },
    decision: "rejected",
    rationale: "Needs revision",
  });
  return { milestoneId, requirementId };
}

/** Schedules the assigned agent's run for the active stage and starts it. */
async function runActiveStage(
  stores: LegacyStores,
  pipelineRunId: string,
  taskId: string,
  agentName: string,
): Promise<string> {
  await stores.pipelineRuns.assign({
    projectId: legacyProjectId,
    pipelineRunId,
    agentId: legacyAgentId(agentName),
    principal: localOperatorPrincipal,
  });
  const agentRunId = await stores.scheduling.execute({
    projectId: legacyProjectId,
    taskId,
    agentId: legacyAgentId(agentName),
  });
  const run = (await stores.runtime.findRun(agentRunId))!;
  run.transition("preparing", stores.clock.now());
  run.transition("running", stores.clock.now());
  await stores.runtime.saveRun(run);
  return agentRunId;
}

/** Completes the active stage from the assigned agent's completed run. */
export async function completeActiveStage(
  stores: LegacyStores,
  pipelineRunId: string,
  taskId: string,
  agentName: string,
): Promise<void> {
  const agentRunId = await runActiveStage(
    stores,
    pipelineRunId,
    taskId,
    agentName,
  );
  // The run is saved as completed while its stage binding is still current.
  const run = (await stores.runtime.findRun(agentRunId))!;
  run.transition("completed", stores.clock.now());
  await stores.runtime.saveRun(run);
  await stores.pipelineRuns.completeStageFromAgentRun({
    projectId: legacyProjectId,
    agentRunId,
  });
  await stores.runtime.releaseTaskLock(agentRunId);
}

export const legacyActivePipelineTaskId = "task-active-pipeline";
export const legacyApprovedPipelineTaskId = "task-approved-pipeline";

/**
 * Builds the pre-pack project database: schema through migration 0040, then
 * legacy state written by the current services. It holds an office, roles and
 * agents (one specialist outside the manifest, one role without an agent),
 * tasks in several states, governance reviews with approvals, a pipeline run
 * with an override, an approved stage and a completed agent run, and a second
 * pipeline run left active on its first stage.
 */
export async function buildPrePackDatabase(root: string): Promise<Database> {
  const partial = join(root, "pre-pack-migrations");
  mkdirSync(partial);
  for (const file of readdirSync(projectMigrations).sort())
    if (file <= lastPrePackMigration)
      copyFileSync(join(projectMigrations, file), join(partial, file));
  const database = openDatabase(join(root, "pre-pack.sqlite"));
  migrate(database, partial);
  // The runner stamps the wall clock; the fixture pins it.
  database
    .query("UPDATE schema_migration SET applied_at = ?")
    .run("2026-09-01T00:00:00.000Z");
  const stores = legacyStores(database);
  await seedOffice(stores);
  await seedGovernance(stores);

  await createTask(stores, "task-pending", "Pending task");
  await createTask(stores, "task-blocked", "Blocked task");
  const blocked = (await stores.tasks.findById("task-blocked"))!;
  blocked.start(stores.clock.now());
  blocked.block(stores.clock.now());
  await stores.tasks.save(blocked);
  await createTask(stores, "task-cancelled", "Cancelled task");
  const cancelled = (await stores.tasks.findById("task-cancelled"))!;
  cancelled.cancel(stores.clock.now());
  await stores.tasks.save(cancelled);
  const failedRun = AgentRun.create({
    id: "agent-run-failed",
    projectId: legacyProjectId,
    taskId: "task-blocked",
    agentId: legacyAgentId("security"),
    now: stores.clock.now(),
  });
  failedRun.transition("preparing", stores.clock.now());
  failedRun.transition("failed", stores.clock.now());
  await stores.runtime.saveRun(failedRun);

  // Run 1: design overridden, implement completed by the developer, review
  // completed by the reviewer and approved; left active on `verify`.
  await createTask(stores, legacyApprovedPipelineTaskId, "Approved feature");
  const approved = (
    await stores.pipelineRuns.start({
      projectId: legacyProjectId,
      taskId: legacyApprovedPipelineTaskId,
      pipelineId: "delivery",
      principal: localOperatorPrincipal,
    })
  ).snapshot().id;
  await stores.pipelineRuns.override({
    projectId: legacyProjectId,
    pipelineRunId: approved,
    principal: localOperatorPrincipal,
    reason: "Design agreed before the office existed",
  });
  await completeActiveStage(
    stores,
    approved,
    legacyApprovedPipelineTaskId,
    "developer",
  );
  await completeActiveStage(
    stores,
    approved,
    legacyApprovedPipelineTaskId,
    "reviewer",
  );
  await stores.pipelineRuns.approveStage({
    projectId: legacyProjectId,
    pipelineRunId: approved,
    principal: localOperatorPrincipal,
    rationale: "Review accepted",
  });

  // Run 2: left active on `design`, unassigned.
  await createTask(stores, legacyActivePipelineTaskId, "Active feature");
  await stores.pipelineRuns.start({
    projectId: legacyProjectId,
    taskId: legacyActivePipelineTaskId,
    pipelineId: "delivery",
    principal: localOperatorPrincipal,
  });
  return database;
}

function sqlLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  if (value instanceof Uint8Array)
    return `X'${Buffer.from(value).toString("hex")}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

interface SchemaObject {
  type: string;
  name: string;
  sql: string;
}

/**
 * A complete, replayable text dump: every table with its rows, then indexes,
 * triggers and views, so that replaying it fires no trigger. Rows are in
 * primary-key (rowid) order.
 */
export function dumpSqliteDatabase(database: Database): string {
  const objects = database
    .query<SchemaObject, []>(
      `SELECT type, name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`,
    )
    .all();
  const lines = ["PRAGMA foreign_keys=OFF;", "BEGIN;"];
  for (const table of objects.filter((item) => item.type === "table")) {
    lines.push(`${table.sql};`);
    const columns = database
      .query<{ name: string }, []>(
        `SELECT name FROM pragma_table_info(${sqlLiteral(table.name)}) ORDER BY cid`,
      )
      .all()
      .map((column) => column.name);
    const rows = database
      .query<Record<string, unknown>, []>(
        `SELECT * FROM ${quoted(table.name)} ORDER BY rowid`,
      )
      .all();
    for (const row of rows)
      lines.push(
        `INSERT INTO ${quoted(table.name)}(${columns.map(quoted).join(",")}) VALUES (${columns
          .map((column) => sqlLiteral(row[column]))
          .join(",")});`,
      );
  }
  for (const item of objects.filter((value) => value.type !== "table"))
    lines.push(`${item.sql};`);
  lines.push("COMMIT;", "");
  return lines.join("\n");
}

/** Every row of every table, as text, for byte comparison. */
export function tableRows(
  database: Database,
  tables?: readonly string[],
): Record<string, string[]> {
  const names =
    tables ??
    database
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
  return Object.fromEntries(
    names.map((name) => [
      name,
      database
        .query<Record<string, unknown>, []>(
          `SELECT * FROM ${quoted(name)} ORDER BY rowid`,
        )
        .all()
        .map((row) =>
          JSON.stringify(row, (_key, value: unknown) =>
            value instanceof Uint8Array
              ? Buffer.from(value).toString("hex")
              : value,
          ),
        ),
    ]),
  );
}

/** Replays the committed pre-pack dump into a new database file. */
export function loadPrePackFixture(root: string): Database {
  const path = join(root, "project.sqlite");
  const raw = new Database(path);
  raw.exec(readFileSync(legacyFixturePath("pre-pack-project.sql"), "utf8"));
  raw.close();
  return openDatabase(path);
}

export function legacyPortability(
  database: Database,
  clock: Clock,
  ids: IdGenerator,
) {
  const states = new SqliteProjectStateRepository(database);
  return {
    states,
    service: new ManageProjectPortability({
      projects: new SqliteProjectRepository(database),
      profiles: new SqliteProjectProfileRepository(database),
      identities: new SqliteRepositoryIdentityRepository(database),
      states,
      bindings: new ExactRootBindingAdapter(),
      scanner: new LocalProjectScanner(),
      transactions: new SqliteTransactionRunner(database),
      ids,
      clock,
      catalog: new InMemoryInstalledDomainPackCatalog(1, []),
    }),
  };
}

/**
 * Builds the four historical archives. The current exporter writes format 6
 * or later, so each archive is the same quiescent legacy project projected
 * onto that format's frozen wire contract by `portableStateAtFormatVersion`,
 * written by the current archive writer under that format's frozen schema.
 */
export async function buildLegacyArchives(
  root: string,
): Promise<Record<LegacyArchiveFormat, string>> {
  const database = openDatabase(join(root, "archive-source.sqlite"));
  try {
    migrate(database, projectMigrations);
    const stores = legacyStores(database);
    await seedOffice(stores);
    const { requirementId } = await seedGovernance(stores);
    await createTask(stores, "task-prerequisite", "Prerequisite");
    await createTask(stores, "task-dependent", "Dependent");
    await new SqliteTaskDependencyRepository(database).link({
      projectId: legacyProjectId,
      taskId: "task-dependent",
      dependsOnTaskId: "task-prerequisite",
      createdAt: stores.clock.now(),
    });
    await new SqliteTaskRequirementRepository(database).link({
      projectId: legacyProjectId,
      taskId: "task-dependent",
      requirementId,
      now: stores.clock.now(),
    });
    const prerequisite = (await stores.tasks.findById("task-prerequisite"))!;
    prerequisite.start(stores.clock.now());
    await stores.tasks.save(prerequisite);
    const run = AgentRun.create({
      id: "agent-run-completed",
      projectId: legacyProjectId,
      taskId: "task-prerequisite",
      agentId: legacyAgentId("developer"),
      now: stores.clock.now(),
    });
    run.transition("preparing", stores.clock.now());
    run.transition("running", stores.clock.now());
    run.transition("completed", stores.clock.now());
    await stores.runtime.saveRun(run);

    const backup = await legacyPortability(
      database,
      stores.clock,
      stores.ids,
    ).service.backup(legacyProjectId);
    const archives = {} as Record<LegacyArchiveFormat, string>;
    for (const formatVersion of legacyArchiveFormats) {
      const state = portableStateAtFormatVersion(
        backup.archive.state,
        formatVersion,
      );
      archives[formatVersion] = serializePortableProjectArchive(
        createPortableProjectArchive({
          state,
          manifest: portableProjectManifestFor({
            formatVersion,
            projectIdentity: backup.archive.manifest.projectIdentity,
            createdAt: backup.archive.manifest.createdAt,
            revision: {
              id: backup.archive.manifest.revision.id,
              stateChecksum: portableStateChecksum(state),
            },
          }),
        }),
      );
    }
    return archives;
  } finally {
    database.close();
  }
}

export function legacyArchiveName(format: LegacyArchiveFormat): string {
  return `format-${format}.aioffice`;
}
