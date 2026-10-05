import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validateSkillPackage } from "./package-validation.ts";
import {
  SkillPackageError,
  canonicalSkillsDirectory,
  contentHash,
  errorMessage,
  installManifestName,
  installTargets,
  isRecord,
  listCanonicalSkills,
  listFiles,
  readSkillVersion,
  repositoryRoot,
  type InstallTarget,
} from "./shared.ts";

export interface PlannedChange {
  readonly kind: "create" | "update" | "delete";
  /** POSIX path relative to the installed skill directory. */
  readonly path: string;
}

export interface TargetReport {
  readonly skill: string;
  readonly version: string | null;
  readonly target: InstallTarget;
  /** POSIX path of the installed skill, relative to the installation root. */
  readonly directory: string;
  readonly changes: readonly PlannedChange[];
  /** Reasons the installer refuses to touch this target. */
  readonly conflicts: readonly string[];
}

export interface InstallReport {
  readonly check: boolean;
  readonly targets: readonly TargetReport[];
  /**
   * Installed copies with no canonical skill in this source (renamed or
   * removed). Executors keep loading them; they are reported, never deleted.
   * Only looked for when installing into the source repository itself: in
   * another repository they may come from a different source.
   */
  readonly orphans: readonly string[];
  /** True when changes were written to disk. */
  readonly applied: boolean;
  /** Install: nothing was refused. Check: every target is in sync. */
  readonly ok: boolean;
}

export interface InstallOptions {
  /** Repository holding the canonical `skills/` directory. */
  readonly sourceRoot?: string;
  /** Repository or directory that receives the installed copies. */
  readonly targetRoot?: string;
  /** Install target ids; all targets when omitted. */
  readonly scopes?: readonly string[];
  /** Report drift without writing anything. */
  readonly check?: boolean;
  /** Adopt unmanaged directories and overwrite locally modified files. */
  readonly force?: boolean;
}

interface InstallManifest {
  readonly schemaVersion: 1;
  readonly skill: string;
  readonly version: string | null;
  readonly files: Readonly<Record<string, string>>;
}

interface TargetPlan extends TargetReport {
  readonly installedRoot: string;
  readonly desired: ReadonlyMap<string, Buffer>;
}

function renderManifest(manifest: InstallManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function readManifest(path: string): InstallManifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== 1 ||
      typeof parsed.skill !== "string" ||
      !isRecord(parsed.files)
    )
      return null;
    const files: Record<string, string> = {};
    for (const [file, hash] of Object.entries(parsed.files)) {
      if (typeof hash !== "string") return null;
      files[file] = hash;
    }
    return {
      schemaVersion: 1,
      skill: parsed.skill,
      version: typeof parsed.version === "string" ? parsed.version : null,
      files,
    };
  } catch {
    return null;
  }
}

/**
 * The first reason `directory` cannot be safely created or written beneath
 * `targetRoot`: a symbolic link or a non-directory anywhere on the way.
 */
function unsafePathReason(
  targetRoot: string,
  directory: string,
): string | null {
  let current = targetRoot;
  let relativePath = "";
  for (const component of directory.split("/")) {
    current = join(current, component);
    relativePath =
      relativePath === "" ? component : `${relativePath}/${component}`;
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      return null;
    }
    if (stats.isSymbolicLink())
      return `${relativePath} is a symbolic link; refusing to write through it`;
    if (!stats.isDirectory())
      return `${relativePath} exists and is not a directory`;
  }
  return null;
}

function planTarget(
  sourceRoot: string,
  targetRoot: string,
  skill: string,
  target: InstallTarget,
  force: boolean,
): TargetPlan {
  const skillRoot = join(sourceRoot, canonicalSkillsDirectory, skill);
  const version = readSkillVersion(skillRoot);
  const directory = `${target.directory}/${skill}`;
  const installedRoot = join(targetRoot, ...directory.split("/"));

  const desired = new Map<string, Buffer>();
  // Maps, not plain objects: file names such as "constructor" must not
  // resolve to inherited properties.
  const hashes = new Map<string, string>();
  for (const file of listFiles(skillRoot)) {
    const content = readFileSync(join(skillRoot, file));
    desired.set(file, content);
    hashes.set(file, contentHash(content));
  }
  const manifestText = renderManifest({
    schemaVersion: 1,
    skill,
    version,
    files: Object.fromEntries(hashes),
  });

  const changes: PlannedChange[] = [];
  const conflicts: string[] = [];
  const plan = (): TargetPlan => ({
    skill,
    version,
    target,
    directory,
    changes,
    conflicts,
    installedRoot,
    desired: new Map([
      ...desired,
      [installManifestName, Buffer.from(manifestText)],
    ]),
  });

  const unsafe = unsafePathReason(targetRoot, directory);
  if (unsafe !== null) {
    conflicts.push(
      `${unsafe} (use --scope to install the other locations only)`,
    );
    return plan();
  }

  let installed: string[] = [];
  if (existsSync(installedRoot)) {
    try {
      installed = listFiles(installedRoot);
    } catch (error) {
      if (!(error instanceof SkillPackageError)) throw error;
      conflicts.push(error.message);
      return plan();
    }
  }
  const manifestPath = join(installedRoot, installManifestName);
  const hasManifestFile = installed.includes(installManifestName);
  const manifest = hasManifestFile ? readManifest(manifestPath) : null;
  const contentFiles = installed.filter((file) => file !== installManifestName);

  // Anything except a regular file where the installer must write one (an
  // empty directory is invisible to listFiles) would fail halfway through.
  for (const file of [...desired.keys(), installManifestName]) {
    // Walk each component: a file where a parent directory is expected must
    // be reported, and lstat on a path beneath it would throw ENOTDIR.
    let current = installedRoot;
    const components = file.split("/");
    for (const [index, component] of components.entries()) {
      current = join(current, component);
      const stats = lstatSync(current, { throwIfNoEntry: false });
      if (stats === undefined) break;
      const isLast = index === components.length - 1;
      if (isLast ? stats.isFile() : stats.isDirectory()) continue;
      const obstacle = `${components.slice(0, index + 1).join("/")} exists and is not a regular ${isLast ? "file" : "directory"}; remove or move it`;
      if (!conflicts.includes(obstacle)) conflicts.push(obstacle);
      break;
    }
  }
  if (conflicts.length > 0) return plan();

  const actualHashes = new Map(
    contentFiles.map((file) => [
      file,
      contentHash(readFileSync(join(installedRoot, file))),
    ]),
  );
  // A directory this installer cannot prove it wrote belongs to the user. It
  // is adopted silently only when nothing in it would be overwritten.
  const unmanaged =
    contentFiles.length > 0 && (manifest === null || manifest.skill !== skill);
  const identical = contentFiles.every(
    (file) => actualHashes.get(file) === hashes.get(file),
  );
  if (unmanaged && !identical && !force) {
    conflicts.push(
      `${directory} already exists, differs from the canonical skill, and was not installed by this installer; move it away, or rerun with --force to adopt it`,
    );
    return plan();
  }
  const recorded = new Map(
    unmanaged ? [] : Object.entries(manifest?.files ?? {}),
  );

  for (const file of contentFiles) {
    const actualHash = actualHashes.get(file);
    const wanted = hashes.get(file);
    if (actualHash === wanted) continue;
    const recordedHash = recorded.get(file);
    // --force adopts only paths the canonical source also owns.
    const owned =
      recordedHash !== undefined || (unmanaged && wanted !== undefined);
    if (!owned) {
      conflicts.push(
        `${file} is not managed by the installer; remove or move it (it is never deleted automatically)`,
      );
      continue;
    }
    const locallyModified =
      recordedHash === undefined || recordedHash !== actualHash;
    if (locallyModified && !force) {
      conflicts.push(
        `${file} was modified after installation; rerun with --force to overwrite it`,
      );
      continue;
    }
    changes.push({
      kind: wanted === undefined ? "delete" : "update",
      path: file,
    });
  }
  for (const file of desired.keys())
    if (!contentFiles.includes(file))
      changes.push({ kind: "create", path: file });

  if (!hasManifestFile)
    changes.push({ kind: "create", path: installManifestName });
  else if (
    readFileSync(manifestPath, "utf8").replace(/\r\n/gu, "\n") !== manifestText
  )
    changes.push({ kind: "update", path: installManifestName });

  return plan();
}

function findOrphans(
  targetRoot: string,
  targets: readonly InstallTarget[],
  skills: readonly string[],
): string[] {
  const orphans: string[] = [];
  for (const target of targets) {
    if (unsafePathReason(targetRoot, target.directory) !== null) continue;
    const directory = join(targetRoot, ...target.directory.split("/"));
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory).sort()) {
      const manifestPath = join(directory, entry, installManifestName);
      if (
        !skills.includes(entry) &&
        lstatSync(join(directory, entry)).isDirectory() &&
        lstatSync(manifestPath, { throwIfNoEntry: false })?.isFile() === true &&
        readManifest(manifestPath) !== null
      )
        orphans.push(`${target.directory}/${entry}`);
    }
  }
  return orphans;
}

function removeEmptyParents(installedRoot: string, relativePath: string): void {
  let directory = dirname(join(installedRoot, ...relativePath.split("/")));
  while (directory.startsWith(installedRoot) && directory !== installedRoot) {
    try {
      rmdirSync(directory);
    } catch {
      return;
    }
    directory = dirname(directory);
  }
}

function applyPlan(plan: TargetPlan): void {
  // The manifest is written last. An interrupted update is still recognized
  // through the previous manifest; an interrupted first install leaves only
  // canonical files, which the next run adopts.
  const ordered = [
    ...plan.changes.filter((change) => change.path !== installManifestName),
    ...plan.changes.filter((change) => change.path === installManifestName),
  ];
  for (const change of ordered) {
    const absolutePath = join(plan.installedRoot, ...change.path.split("/"));
    if (change.kind === "delete") {
      rmSync(absolutePath);
      removeEmptyParents(plan.installedRoot, change.path);
      continue;
    }
    mkdirSync(dirname(absolutePath), { recursive: true });
    const content = plan.desired.get(change.path);
    if (content === undefined)
      throw new SkillPackageError(`No content planned for ${change.path}`);
    const temporaryPath = `${absolutePath}.tmp-${process.pid}`;
    try {
      writeFileSync(temporaryPath, content);
      renameSync(temporaryPath, absolutePath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}

function selectTargets(scopes: readonly string[] | undefined): InstallTarget[] {
  if (scopes === undefined) return [...installTargets];
  if (scopes.length === 0)
    throw new SkillPackageError("No installation scope was selected");
  const selected: InstallTarget[] = [];
  for (const scope of scopes) {
    const target = installTargets.find((candidate) => candidate.id === scope);
    if (target === undefined)
      throw new SkillPackageError(
        `Unknown scope: ${scope} (supported: ${installTargets.map((candidate) => candidate.id).join(", ")})`,
      );
    if (!selected.includes(target)) selected.push(target);
  }
  return selected;
}

/**
 * Installs every canonical skill into each selected executor location, or
 * with `check` reports what an install would change. All targets are planned
 * before anything is written, so a conflict in one leaves every target intact.
 */
export function installSkills(options: InstallOptions = {}): InstallReport {
  const sourceRoot = resolve(options.sourceRoot ?? repositoryRoot);
  const targetRoot = resolve(options.targetRoot ?? sourceRoot);
  const check = options.check ?? false;
  const targets = selectTargets(options.scopes);

  if (!statSync(targetRoot, { throwIfNoEntry: false })?.isDirectory())
    throw new SkillPackageError(
      `Installation root is not a directory: ${targetRoot}`,
    );

  const skills = listCanonicalSkills(sourceRoot);
  if (skills.length === 0)
    throw new SkillPackageError(
      `No canonical skills found under ${join(sourceRoot, canonicalSkillsDirectory)}`,
    );
  for (const skill of skills) {
    const problems = validateSkillPackage(
      join(sourceRoot, canonicalSkillsDirectory, skill),
    );
    if (problems.length > 0)
      throw new SkillPackageError(
        `Canonical skill ${skill} is invalid:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
      );
  }

  const plans = skills.flatMap((skill) =>
    targets.map((target) =>
      planTarget(sourceRoot, targetRoot, skill, target, options.force ?? false),
    ),
  );
  const conflicted = plans.some((plan) => plan.conflicts.length > 0);
  const pending = plans.some((plan) => plan.changes.length > 0);

  const orphans =
    realpathSync(targetRoot) === realpathSync(sourceRoot)
      ? findOrphans(targetRoot, targets, skills)
      : [];

  let applied = false;
  if (!check && !conflicted && pending) {
    for (const plan of plans) applyPlan(plan);
    applied = true;
  }
  return {
    check,
    targets: plans.map(
      ({ skill, version, target, directory, changes, conflicts }) => ({
        skill,
        version,
        target,
        directory,
        changes,
        conflicts,
      }),
    ),
    orphans,
    applied,
    ok: !conflicted && (!check || (!pending && orphans.length === 0)),
  };
}

export function formatInstallReport(report: InstallReport): string {
  const lines: string[] = [];
  for (const target of report.targets) {
    const state =
      target.conflicts.length > 0
        ? "CONFLICT"
        : target.changes.length === 0
          ? "in sync"
          : report.applied
            ? `installed (${target.changes.length} file(s) written or removed)`
            : report.check
              ? "OUT OF SYNC"
              : "not changed";
    lines.push(
      `${target.skill}@${target.version ?? "unversioned"} -> ${target.directory} [${target.target.executors}]: ${state}`,
    );
    for (const conflict of target.conflicts) lines.push(`  ! ${conflict}`);
    for (const change of target.changes)
      if (!report.applied)
        lines.push(`  - would ${change.kind} ${change.path}`);
      else if (change.kind === "delete")
        lines.push(`  - removed ${change.path}`);
  }
  for (const orphan of report.orphans)
    lines.push(
      `${orphan}: ORPHAN - installed by this installer, but ${canonicalSkillsDirectory}/ has no such skill; remove the directory if the skill was renamed or removed`,
    );
  if (report.ok)
    lines.push(
      report.applied
        ? "Skills installed."
        : "Installed skills are in sync with the canonical source.",
    );
  else if (report.targets.some((target) => target.conflicts.length > 0))
    lines.push("Nothing was written. Resolve the conflicts above and retry.");
  else if (report.targets.some((target) => target.changes.length > 0))
    lines.push("Run `bun run skills:install` to synchronize.");
  return lines.join("\n");
}

const usage = `Usage: bun scripts/skills/install.ts [options]

Installs the canonical skills under skills/ into each executor location.

Options:
  --check          Verify installed copies match the source; write nothing
  --root <dir>     Directory that receives the copies (default: this repository)
  --scope <ids>    Comma-separated targets: ${installTargets.map((target) => target.id).join(", ")} (default: all)
  --force          Adopt unmanaged directories and overwrite modified files
  --help           Show this help

Exit codes: 0 success or in sync, 1 drift, conflict, or error, 2 usage error.`;

class UsageError extends Error {}

function parseArguments(argv: readonly string[]): InstallOptions | null {
  let check = false;
  let force = false;
  let targetRoot: string | undefined;
  let scopes: string[] | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") return null;
    if (argument === "--check") check = true;
    else if (argument === "--force") force = true;
    else if (argument === "--root" || argument === "--scope") {
      const value = argv[(index += 1)];
      if (value === undefined || value.startsWith("--"))
        throw new UsageError(`${argument} requires a value`);
      if (argument === "--root") targetRoot = value;
      else {
        scopes = value.split(",").filter((scope) => scope !== "");
        if (scopes.length === 0)
          throw new UsageError("--scope requires at least one target id");
      }
    } else throw new UsageError(`Unknown argument: ${argument}`);
  }
  if (check && force)
    throw new UsageError("--check cannot be combined with --force");
  return {
    check,
    force,
    ...(targetRoot === undefined ? {} : { targetRoot }),
    ...(scopes === undefined ? {} : { scopes }),
  };
}

/** Runs the installer CLI and returns its exit code. */
export function runInstallCli(
  argv: readonly string[],
  output: { log(line: string): void; error(line: string): void } = console,
): number {
  let options: InstallOptions | null;
  try {
    options = parseArguments(argv);
  } catch (error) {
    output.error(`${errorMessage(error)}\n\n${usage}`);
    return 2;
  }
  if (options === null) {
    output.log(usage);
    return 0;
  }
  try {
    const report = installSkills(options);
    const text = formatInstallReport(report);
    if (report.ok) output.log(text);
    else output.error(text);
    return report.ok ? 0 : 1;
  } catch (error) {
    output.error(
      error instanceof SkillPackageError
        ? error.message
        : `Skill installation failed: ${errorMessage(error)}`,
    );
    return 1;
  }
}

if (import.meta.main) process.exitCode = runInstallCli(process.argv.slice(2));
