import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

function sourceDirectory(packageName: string): string {
  return fileURLToPath(
    new URL(`./packages/${packageName}/src`, import.meta.url),
  );
}

export default defineConfig({
  resolve: {
    alias: {
      "@ai-office/agent-client-integrations": sourceDirectory(
        "agent-client-integrations",
      ),
      "@ai-office/agent-runtime": sourceDirectory("agent-runtime"),
      "@ai-office/application": sourceDirectory("application"),
      "@ai-office/connector-sdk": sourceDirectory("connector-sdk"),
      "@ai-office/domain": sourceDirectory("domain"),
      "@ai-office/filesystem-connector": sourceDirectory(
        "filesystem-connector",
      ),
      "@ai-office/llm-gateway": sourceDirectory("llm-gateway"),
      "@ai-office/orchestration": sourceDirectory("orchestration"),
      "@ai-office/runtime-paths": sourceDirectory("runtime-paths"),
      "@ai-office/storage-sqlite": sourceDirectory("storage-sqlite"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
