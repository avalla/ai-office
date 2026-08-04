export interface AgentDefinition {
  id: string;
  role: string;
  version: number;
  capabilities: string[];
  tools: string[];
  modelPolicy: string;
  limits: {
    maxIterations: number;
    maxCostMicros: bigint;
    timeoutSeconds: number;
  };
}
