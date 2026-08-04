export type ProjectId = string;

export interface ProjectProps {
  id: ProjectId;
  name: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

export class Project {
  private constructor(private readonly props: ProjectProps) {}

  static create(input: {
    id: ProjectId;
    name: string;
    description?: string;
    now: Date;
  }): Project {
    const name = input.name.trim();

    if (name.length === 0) {
      throw new Error("Project name cannot be empty");
    }

    return new Project({
      id: input.id,
      name,
      ...(input.description === undefined ? {} : { description: input.description }),
      createdAt: input.now,
      updatedAt: input.now
    });
  }

  static restore(props: ProjectProps): Project {
    return new Project(props);
  }

  snapshot(): ProjectProps {
    return { ...this.props };
  }
}
