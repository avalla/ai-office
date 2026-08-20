import type {
  OfficeManifestRevision,
  OfficePipeline,
  OfficeTaskKind,
} from "@ai-office/domain/office/office-manifest.ts";
import type { ProjectProfileSnapshot } from "@ai-office/domain/project/project-profile.ts";
import {
  OfficeManifestNotFoundError,
  OfficePipelineNotFoundError,
  ProjectNotFoundError,
} from "../errors.ts";
import type { OfficeManifestRepository } from "../ports/office-manifest-repository.port.ts";
import type { ProjectProfileRepository } from "../ports/project-profile-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import { GetProjectProfile } from "./get-project-profile.ts";

export interface OfficeContext {
  profileSemantics: "evidence";
  currentOfficeSemantics: "approved_configuration";
  profile: ProjectProfileSnapshot;
  current: OfficeManifestRevision | null;
}

export class GetOfficeContext {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly profiles: ProjectProfileRepository,
    private readonly manifests: OfficeManifestRepository,
  ) {}

  async execute(projectId: string): Promise<OfficeContext> {
    const [profile, current] = await Promise.all([
      new GetProjectProfile(this.projects, this.profiles).execute(projectId),
      this.manifests.findLatest(projectId),
    ]);
    return {
      profileSemantics: "evidence",
      currentOfficeSemantics: "approved_configuration",
      profile,
      current,
    };
  }

  async resolvePipeline(
    projectId: string,
    taskKind: OfficeTaskKind,
  ): Promise<OfficePipeline> {
    const project = await this.projects.findById(projectId);
    if (project === null) throw new ProjectNotFoundError(projectId);
    const current = await this.manifests.findLatest(projectId);
    if (current === null) throw new OfficeManifestNotFoundError(projectId);
    const pipeline = current.manifest.pipelines.find((candidate) =>
      candidate.defaultFor.includes(taskKind),
    );
    if (pipeline === undefined)
      throw new OfficePipelineNotFoundError(projectId, taskKind);
    return pipeline;
  }
}
