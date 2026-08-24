export interface RepositoryIdentityAssociation {
  repositoryId: string;
  projectId: string;
  createdAt: Date;
}

export interface RepositoryIdentityRepository {
  findProjectId(repositoryId: string): Promise<string | null>;
  findRepositoryId(projectId: string): Promise<string | null>;
  associate(
    association: RepositoryIdentityAssociation,
  ): Promise<"created" | "existing" | "conflict">;
}
