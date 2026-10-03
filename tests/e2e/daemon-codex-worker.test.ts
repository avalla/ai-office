import { expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runRuntime } from "../helpers/run-runtime.ts";

test("Codex CLI worker persists provenance and a bounded result through the Runtime", async () => {
  const runtime = await runRuntime();
  const oldPath = process.env.PATH;
  try {
    const bin = join(runtime.root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      `#!${process.execPath}\n
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.160.0'); process.exit(0); }
if (args[0] !== 'exec' || !args.includes('--json') || args[args.indexOf('--sandbox') + 1] !== 'read-only' || !args.includes('shell_tool') || !args.includes('unified_exec')) process.exit(1);
const prompt = await Bun.stdin.text();
if (!prompt.includes('Test task')) process.exit(1);
for (const event of [
  {type:'thread.started',thread_id:'fixture-thread'},
  {type:'turn.started'},
  {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({summary:'Codex analysis',content:'Explicit context only'})}},
  {type:'turn.completed',usage:{input_tokens:5,output_tokens:7}}
]) console.log(JSON.stringify(event));
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    const taskId = await runtime.task();
    const runId = (await runtime.schedule(taskId)).stdout[0]!.replace(
      "Agent run scheduled: ",
      "",
    );
    const result = await runtime.command([
      "run:tick",
      "--project",
      runtime.projectId,
      "--worker",
      "codex",
      "--json",
    ]);
    expect(result, result.stderr.join("\n")).toMatchObject({ exitCode: 0 });
    const response = await fetch(`http://localhost/api/runs/${runId}`, {
      unix: runtime.socketPath,
    });
    expect(response.status).toBe(200);
    const { run: detail } = (await response.json()) as {
      run: {
        run: {
          status: string;
          execution: { adapterId: string; adapterVersion: string };
        };
        workerOutput: { summary: string; estimatedCostUsd: number | null };
      };
    };
    expect(detail.run).toMatchObject({
      status: "completed",
      execution: { adapterId: "codex-cli", adapterVersion: "0.160.0" },
    });
    expect(detail.workerOutput).toMatchObject({
      summary: "Codex analysis",
      estimatedCostUsd: null,
    });
  } finally {
    process.env.PATH = oldPath;
    await runtime.close();
  }
});
