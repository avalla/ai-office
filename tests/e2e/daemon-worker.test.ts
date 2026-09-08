import { expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runRuntime } from "../helpers/run-runtime.ts";
import type {
  AgentRunDetail,
  TaskDetail,
} from "@ai-office/application/read-models/operational-read-models.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { renderRun } from "../../apps/dashboard/src/ui/render.ts";
import { runViewModel } from "../../apps/dashboard/src/ui/view-model.ts";

test("queued tasks require an explicit executor; simulation is durable and never inferred for historical runs", async () => {
  const r = await runRuntime();
  try {
    const scheduled = await r.schedule(await r.task());
    const runId = scheduled.stdout[0]!.replace("Agent run scheduled: ", "");
    const missing = await r.command(["run:tick", "--project", r.projectId]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.join(" ")).toContain("No runs were started");
    const show = () =>
      r.command(["run:show", "--project", r.projectId, "--run", runId]);
    expect((await show()).stdout).toContain("Status: queued");
    expect((await show()).stdout).toContain("Executor: not recorded");
    expect(
      (
        await r.command([
          "run:tick",
          "--project",
          r.projectId,
          "--worker",
          "claude",
          "--simulate",
        ])
      ).exitCode,
    ).toBe(1);
    expect(
      (await r.command(["run:tick", "--project", r.projectId, "--simulate"]))
        .exitCode,
    ).toBe(0);
    expect((await show()).stdout).toContain(
      "Executor: simulation (simulated 1)",
    );
  } finally {
    await r.close();
  }
});

test("a subprocess worker produces a persisted, inspectable result through the daemon without completing the task", async () => {
  const r = await runRuntime();
  const oldPath = process.env.PATH;
  try {
    const bin = join(r.root, "bin");
    mkdirSync(bin);
    // A deterministic process double: this test never calls an installed client or a provider.
    writeFileSync(
      join(bin, "claude"),
      `#!${process.execPath}\n
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.236 (Claude Code)'); process.exit(0); }
if (args[0] === '--help') { console.log('--safe-mode --tools --strict-mcp-config --setting-sources --no-session-persistence --json-schema --disable-slash-commands'); process.exit(0); }
if (args[args.indexOf('--tools') + 1] !== '' || !args.includes('--safe-mode')) process.exit(1);
const input = JSON.parse(await Bun.stdin.text());
console.log(JSON.stringify({type:'result', subtype:'success', is_error:false,
 structured_output:{summary:'Analysis for ' + input.task.title, content:'<script>untrusted</script>\\nExplicit context only: ' + input.agent.roleKey},
 session_id:'fixture-session', modelUsage:{'fixture-model':{}}, usage:{input_tokens:10,output_tokens:20},total_cost_usd:0.001,
 hidden_reasoning:'SECRET_ENVELOPE'}));
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    const taskId = await r.task();
    const runId = (await r.schedule(taskId)).stdout[0]!.replace(
      "Agent run scheduled: ",
      "",
    );
    const result = await r.command([
      "run:tick",
      "--project",
      r.projectId,
      "--worker",
      "claude",
      "--json",
    ]);
    expect(result, result.stderr.join("\n")).toMatchObject({ exitCode: 0 });
    const get = async <T>(path: string): Promise<T> => {
      const response = await fetch(`http://localhost${path}`, {
        unix: join(r.root, "daemon.sock"),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as T;
    };
    const { run: detail } = await get<{ run: AgentRunDetail }>(
      `/api/runs/${runId}`,
    );
    expect(detail.run).toMatchObject({
      status: "completed",
      execution: {
        kind: "worker",
        adapterId: "claude-code",
        adapterVersion: "2.1.236",
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      worktreePath: null,
    });
    expect(detail.workerOutput).toMatchObject({
      summary: "Analysis for Test task",
      sessionId: "fixture-session",
      model: "fixture-model",
    });
    expect(JSON.stringify(detail)).not.toContain("SECRET_ENVELOPE");
    const { task } = await get<{ task: TaskDetail }>(
      `/api/projects/${r.projectId}/tasks/${taskId}`,
    );
    expect(task.task.recordedStatus).toBe("pending");
    expect(task.runs.items[0]?.execution?.kind).toBe("worker");
    const html = renderRun(runViewModel(detail));
    expect(html).toContain("Worker output");
    expect(html).toContain("&lt;script&gt;untrusted&lt;/script&gt;");
    expect(html).not.toContain("<script>untrusted</script>");
    const db = openDatabase(join(r.root, ".ai-office", "project.sqlite"));
    try {
      expect(
        db
          .query<{ execution: string }, [string]>(
            "SELECT json_extract(payload_json, '$.execution.kind') execution FROM agent_run_event WHERE run_id=? AND status='running'",
          )
          .get(runId)?.execution,
      ).toBe("worker");
      expect(() =>
        db
          .prepare("UPDATE agent_run SET execution_json=NULL WHERE id=?")
          .run(runId),
      ).toThrow("immutable");
      expect(
        db
          .query<{ count: number }, []>("SELECT COUNT(*) count FROM task_lock")
          .get()?.count,
      ).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await r.close();
  }
});
