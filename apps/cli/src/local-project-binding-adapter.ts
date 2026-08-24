import { randomUUID, createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ProjectBindingAdapter } from "@ai-office/application/ports/project-binding-adapter.port.ts";
import {
  parseProjectBinding,
  projectBindingFile,
  projectBindingPlanHash,
  ProjectBindingError,
  serializeProjectBinding,
  type ProjectBinding,
  type ProjectBindingInspection,
  type ProjectBindingRemovePlan,
  type ProjectBindingWritePlan,
} from "@ai-office/application/project-lifecycle/project-binding.ts";

const maximumBindingBytes = 64 * 1024;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalDirectory(inputPath: string): string {
  let rootPath: string;
  try {
    rootPath = realpathSync(resolve(inputPath));
  } catch {
    throw new ProjectBindingError(
      `Project path does not exist: ${resolve(inputPath)}`,
    );
  }
  if (!statSync(rootPath).isDirectory())
    throw new ProjectBindingError(
      `Project path is not a directory: ${rootPath}`,
    );
  return rootPath;
}

function invalidInspection(
  searchedFrom: string,
  rootPath: string,
  issue: string,
): ProjectBindingInspection {
  return {
    status: "invalid",
    searchedFrom,
    rootPath,
    bindingPath: join(rootPath, projectBindingFile),
    issue,
  };
}

function inspectAt(
  searchedFrom: string,
  rootPath: string,
): ProjectBindingInspection | null {
  const statePath = join(rootPath, ".ai-office");
  const bindingPath = join(rootPath, projectBindingFile);
  if (!existsSync(statePath)) return null;

  const state = lstatSync(statePath);
  if (state.isSymbolicLink() || !state.isDirectory())
    return invalidInspection(
      searchedFrom,
      rootPath,
      ".ai-office must be a real directory, not a symlink or another filesystem type",
    );
  if (!existsSync(bindingPath)) return null;

  const bindingStatus = lstatSync(bindingPath);
  if (bindingStatus.isSymbolicLink() || !bindingStatus.isFile())
    return invalidInspection(
      searchedFrom,
      rootPath,
      `${projectBindingFile} must be a regular file and cannot be a symlink`,
    );
  if (bindingStatus.size > maximumBindingBytes)
    return invalidInspection(
      searchedFrom,
      rootPath,
      `${projectBindingFile} exceeds ${maximumBindingBytes} bytes`,
    );

  const contents = readFileSync(bindingPath, "utf8");
  try {
    const binding = parseProjectBinding(JSON.parse(contents) as unknown);
    return {
      status: "valid",
      searchedFrom,
      rootPath,
      bindingPath,
      binding,
      sha256: sha256(contents),
    };
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Project binding is invalid";
    return invalidInspection(searchedFrom, rootPath, detail);
  }
}

function writePlanHash(
  plan: Omit<ProjectBindingWritePlan, "planHash">,
): string {
  return projectBindingPlanHash(plan);
}

function removePlanHash(
  plan: Omit<ProjectBindingRemovePlan, "planHash">,
): string {
  return projectBindingPlanHash(plan);
}

function ensureStateDirectory(rootPath: string): string {
  const statePath = join(rootPath, ".ai-office");
  if (!existsSync(statePath)) {
    try {
      mkdirSync(statePath, { mode: 0o755 });
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
    }
  }
  const state = lstatSync(statePath);
  if (state.isSymbolicLink() || !state.isDirectory())
    throw new ProjectBindingError(
      ".ai-office must be a real directory before writing the project binding",
    );
  return statePath;
}

export class LocalProjectBindingAdapter implements ProjectBindingAdapter {
  async inspect(
    inputPath: string,
    options: { ancestors?: boolean } = {},
  ): Promise<ProjectBindingInspection> {
    const searchedFrom = canonicalDirectory(inputPath);
    let current = searchedFrom;
    const startingDevice = statSync(searchedFrom).dev;

    while (true) {
      const inspection = inspectAt(searchedFrom, current);
      if (inspection !== null) return inspection;
      if (options.ancestors !== true) break;
      const parent = dirname(current);
      if (parent === current || statSync(parent).dev !== startingDevice) break;
      current = parent;
    }

    return {
      status: "missing",
      searchedFrom,
      rootPath: searchedFrom,
      bindingPath: join(searchedFrom, projectBindingFile),
    };
  }

  async planWrite(
    rootPath: string,
    binding: ProjectBinding,
  ): Promise<ProjectBindingWritePlan> {
    const parsed = parseProjectBinding(binding);
    if (parsed.schemaVersion !== 2)
      throw new ProjectBindingError("Cannot write a legacy project binding");
    const inspection = await this.inspect(rootPath);
    if (inspection.status === "invalid")
      throw new ProjectBindingError(
        inspection.issue ?? "Project binding is invalid",
      );

    const currentMatches =
      inspection.status === "valid" &&
      inspection.binding?.schemaVersion === 2 &&
      inspection.binding.repositoryId === parsed.repositoryId;
    const planWithoutHash: Omit<ProjectBindingWritePlan, "planHash"> = {
      contractVersion: 1,
      action:
        inspection.status === "missing"
          ? "create"
          : currentMatches
            ? "none"
            : "update",
      rootPath: inspection.rootPath,
      relativePath: projectBindingFile,
      expectedSha256: inspection.sha256 ?? null,
      binding: parsed,
    };
    return { ...planWithoutHash, planHash: writePlanHash(planWithoutHash) };
  }

  async applyWrite(plan: ProjectBindingWritePlan): Promise<void> {
    const current = await this.planWrite(plan.rootPath, plan.binding);
    if (current.planHash !== plan.planHash)
      throw new ProjectBindingError(
        "Project binding changed after planning; run install again",
      );
    if (plan.action === "none") return;

    const statePath = ensureStateDirectory(plan.rootPath);
    const targetPath = join(plan.rootPath, projectBindingFile);
    const temporaryPath = join(
      statePath,
      `.project.ai-office-${randomUUID()}.tmp`,
    );
    try {
      writeFileSync(temporaryPath, serializeProjectBinding(plan.binding), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      });
      const latest = await this.inspect(plan.rootPath);
      if ((latest.sha256 ?? null) !== plan.expectedSha256)
        throw new ProjectBindingError(
          "Project binding changed during installation",
        );
      if (plan.expectedSha256 === null) {
        linkSync(temporaryPath, targetPath);
        unlinkSync(temporaryPath);
      } else {
        renameSync(temporaryPath, targetPath);
      }
    } catch (error) {
      if (existsSync(temporaryPath)) rmSync(temporaryPath);
      if (error instanceof ProjectBindingError) throw error;
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        throw new ProjectBindingError(
          "Project binding changed during installation",
        );
      throw error;
    }
  }

  async planRemove(rootPath: string): Promise<ProjectBindingRemovePlan> {
    const inspection = await this.inspect(rootPath);
    if (inspection.status === "invalid")
      throw new ProjectBindingError(
        inspection.issue ?? "Project binding is invalid",
      );
    const planWithoutHash: Omit<ProjectBindingRemovePlan, "planHash"> = {
      contractVersion: 1,
      action: inspection.status === "valid" ? "delete" : "none",
      rootPath: inspection.rootPath,
      relativePath: projectBindingFile,
      expectedSha256: inspection.sha256 ?? null,
    };
    return { ...planWithoutHash, planHash: removePlanHash(planWithoutHash) };
  }

  async applyRemove(plan: ProjectBindingRemovePlan): Promise<void> {
    const current = await this.planRemove(plan.rootPath);
    if (current.planHash !== plan.planHash)
      throw new ProjectBindingError(
        "Project binding changed after planning; request a new uninstall plan",
      );
    if (plan.action === "none") return;
    unlinkSync(join(plan.rootPath, projectBindingFile));

    const statePath = join(plan.rootPath, ".ai-office");
    if (readdirSync(statePath).length === 0) rmdirSync(statePath);
  }
}
