export type AgentId = string;

export interface Agent {
  id: AgentId;
  name: string;
  roleId: string;
  modelPolicy: string;
  enabled: boolean;
}
