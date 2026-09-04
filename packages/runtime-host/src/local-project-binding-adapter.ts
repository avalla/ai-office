import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  renameSync,
  readdirSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ProjectBindingAdapter } from "@ai-office/application/ports/project-binding-adapter.port.ts";
import {
  parseProjectBinding,
  projectBindingFile,
  projectBindingPlanHash,
  ProjectBindingError,
  serializeProjectBinding,
  type ProjectBinding,
  type ProjectBindingRemovePlan,
  type ProjectBindingWritePlan,
} from "@ai-office/application/project-lifecycle/project-binding.ts";
import { LocalProjectBindingReader } from "@ai-office/project-binding/local-project-binding-reader.ts";
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

export class LocalProjectBindingAdapter
  extends LocalProjectBindingReader
  implements ProjectBindingAdapter
{
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
