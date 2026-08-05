export interface Agent {
  id: AgentId;
  projectId: string;
  name: string;
  roleId: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type AgentId = string;
