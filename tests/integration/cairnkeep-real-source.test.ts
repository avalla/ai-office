import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { deriveProjectMemoryIdentity } from "@ai-office/application/project-memory/project-memory-identity.ts";
import {
  CairnKeepMemoryProvider,
  supportedMcpProtocolVersions,
} from "@ai-office/cairnkeep-memory/cairnkeep-memory-provider.ts";
import { McpStdioSession } from "@ai-office/cairnkeep-memory/mcp-stdio-session.ts";

/** Opt in with the packaged v2.19.0 bin/cairn path. Every store path is temporary. */
const cairnCli = process.env.AI_OFFICE_TEST_CAIRNKEEP_CLI;

test.skipIf(!cairnCli)("real CairnKeep v2.19.0 named-scope read-only import scan", async () => {
  const root = mkdtempSync(join(tmpdir(), "ai-office-real-cairn-"));
  const command = join(root, "cairn");
  const baseDirectory = join(root, "store");
  const identity = deriveProjectMemoryIdentity("repo_real_cairn_smoke");
  const home = join(root, "home");
  const child = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    CAIRN_AGENTFS_BASE_DIR: baseDirectory,
    CAIRN_MCP_TOOL_PROFILE: "custom",
    CAIRN_MCP_ALLOWED_TOOLS: "memory_write",
  };
  let writer: McpStdioSession | undefined;
  try {
    const version = spawnSync(process.execPath, [cairnCli!, "--version"], {
      encoding: "utf8", env: child, timeout: 5_000,
    });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe("cairnkeep 2.19.0");
    // The packaged script has a Node shebang; this isolated wrapper uses the test's Bun runtime.
    writeFileSync(command, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(cairnCli!).href)};\n`);
    chmodSync(command, 0o700);
    writer = await McpStdioSession.start({
      command, args: ["memory-server"], environment: child,
      deadlineMs: 15_000, maxMessageBytes: 256 * 1024, maxTotalBytes: 512 * 1024,
    });
    const initialized = await writer.request("initialize", {
      protocolVersion: supportedMcpProtocolVersions[0], capabilities: {},
      clientInfo: { name: "ai-office-smoke", version: "0.1.0" },
    });
    expect(initialized).toMatchObject({ serverInfo: { name: "cairn-memory", version: "0.1.0" } });
    writer.markInitialized();
    writer.notify("notifications/initialized");
    const write = await writer.request("tools/call", {
      name: "memory_write",
      arguments: { scope: identity.memoryProjectId, key: "decisions/smoke", value: "Keep exact origin" },
    });
    expect(write).toMatchObject({ structuredContent: { ok: true, scope: identity.memoryProjectId } });
    await writer.close();
    writer = undefined;
    const provider = new CairnKeepMemoryProvider({
      command, timeoutMs: 15_000, baseDirectory,
      environment: { PATH: process.env.PATH, HOME: home },
    });
    expect(await provider.readNamedScope(identity.memoryProjectId)).toEqual([
      { key: "decisions/smoke", value: "Keep exact origin" },
    ]);
  } finally {
    await writer?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
