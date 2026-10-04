import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerContext } from "@ai-office/application/ports/worker-runtime.port.ts";
import { CodexWorkerRuntime } from "@ai-office/agent-runtime/codex-worker-runtime.ts";
import { codexLogin } from "../helpers/fake-codex.ts";

/**
 * A known limitation, pinned so it is not forgotten or documented away: the
 * `apply_patch` tool that codex-cli 0.160.0 offers the admitted model reads
 * its target before the read-only sandbox refuses the write, and answers the
 * model differently for each state of that path. The fixture is what the real
 * CLI returned, with the temporary fixture directory written as `$FX`.
 *
 * The replay needs the real audited CLI and is opt-in:
 * `AI_OFFICE_REAL_CODEX_CLI=/path/to/codex`. It uses a forged login and a
 * loopback provider, so no credential and no paid request is involved.
 */
interface Probe {
  name: string;
  patch: string;
  response: string;
}
const recorded = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/codex-cli-0.160.0-apply-patch-oracle.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { cli: string; probes: Probe[] };
const response = (name: string) =>
  recorded.probes.find((probe) => probe.name === name)!.response;
const refusedWrite =
  "patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings";
const realCodex = process.env.AI_OFFICE_REAL_CODEX_CLI;

const context: WorkerContext = {
  schemaVersion: 1,
  projectId: "project",
  runId: "run",
  task: {
    id: "task",
    title: "Review evidence",
    description: null,
    updatedAt: "2026-09-07T00:00:00.000Z",
  },
  agent: {
    id: "reviewer",
    name: "Reviewer",
    roleId: "role",
    roleKey: "reviewer",
    roleVersion: 1,
  },
  stage: null,
  memory: { results: [] },
  model: {
    policy: "balanced",
    profile: "balanced",
    modelRef: "openai:gpt-5.5",
    providerId: "openai",
    model: "gpt-5.5",
    reasoningEffort: "low",
    maxOutputTokens: null,
    source: "role_policy",
  },
};

describe("apply_patch host-file oracle of codex-cli 0.160.0", () => {
  test("the recorded CLI tells the model whether a path exists and whether a guessed line is in it", () => {
    expect(recorded.cli).toBe("codex-cli 0.160.0");
    // Nothing is written: a patch that would apply is refused by the sandbox.
    expect(response("correct whole line")).toBe(refusedWrite);
    // But only after the target was read, so the refusal confirms the guess.
    expect(response("missing file")).toContain("No such file or directory");
    expect(response("wrong guess")).toContain("Failed to find expected lines");
    expect(
      new Set(
        ["missing file", "wrong guess", "correct whole line"].map(response),
      ).size,
    ).toBe(3);
    // The oracle is whole-line equality, not a prefix or substring search,
    // and a refused guess echoes the guess, never the file.
    expect(response("line prefix")).toContain("Failed to find expected lines");
    expect(response("context prefix")).toContain("Failed to find context");
    for (const probe of recorded.probes)
      expect(probe.response).not.toContain("7f3a9c-synthetic");
    // It follows symbolic links and tells files, directories, unreadable
    // files and non-UTF-8 content apart.
    expect(response("correct line through a symlink")).toBe(refusedWrite);
    expect(response("unreadable file")).toContain("Permission denied");
    expect(response("directory")).toContain("is not a file");
    expect(response("not UTF-8")).toContain("invalid utf-8");
  });

  describe.runIf(realCodex !== undefined && process.platform !== "win32")(
    "replayed against the real CLI",
    () => {
      let root: string;
      beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "ao-codex-oracle-"));
      });
      afterEach(() => {
        chmodSync(join(root, "fx", "unreadable.txt"), 0o600);
        rmSync(root, { recursive: true, force: true });
      });

      test("the worker's own invocation reproduces the recording and the run is still accepted", async () => {
        const fx = join(root, "fx");
        mkdirSync(join(fx, "dir"), { recursive: true });
        const known =
          "alpha-line-one\nSYNTH-SECRET=7f3a9c-synthetic\ngamma-line-three\n";
        writeFileSync(join(fx, "known.txt"), known);
        symlinkSync(join(fx, "known.txt"), join(fx, "link.txt"));
        writeFileSync(join(fx, "binary.bin"), Buffer.from([0xff, 0xfe, 0x0a]));
        writeFileSync(join(fx, "unreadable.txt"), "x\n");
        chmodSync(join(fx, "unreadable.txt"), 0o000);
        const before = readdirSync(fx).sort();

        const outputs: string[] = [];
        let turn = 0;
        const sse = (events: { type: string; [key: string]: unknown }[]) =>
          new Response(
            events
              .map(
                (event) =>
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              )
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        const provider = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          async fetch(request) {
            const url = new URL(request.url);
            if (
              request.method !== "POST" ||
              !url.pathname.endsWith("/responses")
            )
              return new Response("not found", { status: 404 });
            let raw: Uint8Array = new Uint8Array(await request.arrayBuffer());
            if (request.headers.get("content-encoding")?.includes("zstd"))
              raw = Bun.zstdDecompressSync(raw);
            const body = JSON.parse(new TextDecoder().decode(raw)) as {
              input?: { type?: string; output?: unknown }[];
            };
            outputs.splice(
              0,
              outputs.length,
              ...(body.input ?? [])
                .filter((item) => item.type === "custom_tool_call_output")
                .map((item) =>
                  typeof item.output === "string"
                    ? item.output
                    : JSON.stringify(item.output),
                ),
            );
            const id = `resp_${turn}`;
            const probe = recorded.probes[turn++];
            const item =
              probe === undefined
                ? {
                    type: "message",
                    role: "assistant",
                    id: "msg",
                    content: [
                      {
                        type: "output_text",
                        text: JSON.stringify({ summary: "s", content: "c" }),
                      },
                    ],
                  }
                : {
                    type: "custom_tool_call",
                    name: "apply_patch",
                    call_id: `call_${turn}`,
                    id: `ctc_${turn}`,
                    input: probe.patch.replaceAll("$FX", fx),
                  };
            return sse([
              { type: "response.created", response: { id } },
              { type: "response.output_item.done", item },
              {
                type: "response.completed",
                response: {
                  id,
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              },
            ]);
          },
        });
        try {
          // The worker's argv is used as is; the wrapper only points the real
          // CLI at the loopback provider.
          const wrapper = join(root, "codex");
          const base = `http://127.0.0.1:${provider.port}`;
          writeFileSync(
            wrapper,
            `#!/bin/sh\nif [ "$1" = exec ]; then shift; exec '${realCodex}' exec -c 'openai_base_url="${base}/v1"' -c 'chatgpt_base_url="${base}/backend-api/"' "$@"; fi\nexec '${realCodex}' "$@"\n`,
            { mode: 0o700 },
          );
          const operatorHome = join(root, "operator");
          mkdirSync(operatorHome);
          writeFileSync(
            join(operatorHome, "auth.json"),
            codexLogin("pro", "refresh-fixture"),
            { mode: 0o600 },
          );
          const result = await new CodexWorkerRuntime(
            wrapper,
            undefined,
            undefined,
            undefined,
            operatorHome,
          ).execute(context, {
            timeoutMs: 120000,
            maxTurns: 2,
            maxEstimatedCostUsd: "0.100000",
            maxCostMicros: 100000n,
          });

          // The probes are invisible in the worker's result.
          expect(result).toMatchObject({ summary: "s", content: "c" });
          expect(outputs.map((output) => output.replaceAll(fx, "$FX"))).toEqual(
            recorded.probes.map((probe) => probe.response),
          );
          // Nothing was written.
          expect(readdirSync(fx).sort()).toEqual(before);
          expect(readFileSync(join(fx, "known.txt"), "utf8")).toBe(known);
        } finally {
          await provider.stop(true);
        }
      }, 150000);
    },
  );
});
