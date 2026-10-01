import { join } from "node:path";

/** Managed Agent Knowledge has one non-secret file and a separate credential source. */
export const runtimeHomeAgentKnowledgeFileName = "agent-knowledge.json";
export const agentKnowledgeSourceEnvironmentVariable =
  "AI_OFFICE_AGENT_KNOWLEDGE_SOURCE";
export const runtimeHomeAgentKnowledgeSource = "runtime_home";

export function runtimeHomeAgentKnowledgePath(runtimeHome: string): string {
  return join(runtimeHome, runtimeHomeAgentKnowledgeFileName);
}
