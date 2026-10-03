import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `codex features list` as printed by the real codex-cli 0.160.0. */
export const codexFeatureListing = readFileSync(
  fileURLToPath(
    new URL("../fixtures/codex-cli-0.160.0-features.txt", import.meta.url),
  ),
  "utf8",
);

/** The listing after `--disable`; 0.160.0 ignores it for `unified_exec`. */
export function codexFeatureListingAfter(args: readonly string[]): string {
  const disabled = new Set(
    args.filter((_, index) => args[index - 1] === "--disable"),
  );
  return codexFeatureListing
    .split("\n")
    .map((line) => {
      const name = line.split(/\s+/)[0]!;
      return disabled.has(name) && name !== "unified_exec"
        ? line.replace(/true$/, "false")
        : line;
    })
    .join("\n");
}

export type FakeCodexMode = "ok" | "fail" | "hang" | "tool";

export interface FakeCodexReport {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  cwdEntries: string[];
  home: { entries: string[]; mode: number };
  codexHome: { entries: string[]; mode: number };
  auth: { content: string; mode: number } | null;
  prompt: string;
}

/**
 * A stand-in `codex` executable that records the environment, working
 * directory and Codex home it was started with before answering.
 */
export function installFakeCodex(root: string) {
  const bin = join(root, "bin");
  const reportPath = join(root, "codex-report.json");
  const modePath = join(root, "codex-mode");
  const listingPath = join(root, "codex-features.txt");
  mkdirSync(bin, { recursive: true });
  writeFileSync(listingPath, codexFeatureListing);
  writeFileSync(modePath, "ok");
  const executable = join(bin, "codex");
  writeFileSync(
    executable,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.160.0"); process.exit(0); }
if (args[0] === "features") {
  const off = new Set(args.filter((_, i) => args[i - 1] === "--disable"));
  const lines = fs.readFileSync(${JSON.stringify(listingPath)}, "utf8").split("\\n");
  for (const name of off) if (!lines.some((line) => line.split(/\\s+/)[0] === name)) { console.error("Error: Unknown feature flag: " + name); process.exit(1); }
  console.log(lines.map((line) => { const name = line.split(/\\s+/)[0]; return off.has(name) && name !== "unified_exec" ? line.replace(/true$/, "false") : line; }).join("\\n"));
  process.exit(0);
}
if (args[0] !== "exec") process.exit(1);
const mode = fs.readFileSync(${JSON.stringify(modePath)}, "utf8").trim();
const list = (dir) => ({ entries: fs.readdirSync(dir).sort(), mode: fs.statSync(dir).mode & 0o777 });
const authPath = path.join(process.env.CODEX_HOME, "auth.json");
const auth = fs.existsSync(authPath) ? { content: fs.readFileSync(authPath, "utf8"), mode: fs.statSync(authPath).mode & 0o777 } : null;
const prompt = await Bun.stdin.text();
fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ args, env: process.env, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()).sort(), home: list(process.env.HOME), codexHome: list(process.env.CODEX_HOME), auth, prompt }));
// A real client writes session state into its home; cleanup must remove it.
fs.writeFileSync(path.join(process.env.CODEX_HOME, "state.sqlite"), "state");
if (mode === "fail") { console.error("login failed for " + (auth === null ? "nobody" : auth.content)); process.exit(1); }
if (mode === "hang") { setInterval(() => {}, 1000); await new Promise(() => {}); }
const events = [
  { type: "thread.started", thread_id: "fixture-thread" },
  { type: "item.completed", item: { id: "item_0", type: "error", message: "Code Mode is unavailable because code-mode host is disabled." } },
  { type: "turn.started" },
  ...(mode === "tool" ? [{ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "cat /etc/passwd" } }] : []),
  { type: "item.completed", item: { id: "item_2", type: "agent_message", text: JSON.stringify({ summary: "Codex analysis", content: "Explicit context only" }) } },
  { type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 } },
];
for (const event of events) console.log(JSON.stringify(event));
`,
    { mode: 0o700 },
  );
  return {
    bin,
    executable,
    setMode: (mode: FakeCodexMode) => writeFileSync(modePath, mode),
    setFeatureListing: (listing: string) => writeFileSync(listingPath, listing),
    report: () =>
      JSON.parse(readFileSync(reportPath, "utf8")) as FakeCodexReport,
  };
}

/** An operator Codex home holding a login plus state the worker must not see. */
export function createOperatorCodexHome(root: string, secret: string): string {
  const home = join(root, "operator-codex-home");
  mkdirSync(join(home, "skills", "ambient"), { recursive: true });
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: secret }),
    { mode: 0o600 },
  );
  writeFileSync(join(home, "AGENTS.md"), "AMBIENT GLOBAL INSTRUCTIONS");
  writeFileSync(join(home, "AGENTS.override.md"), "AMBIENT OVERRIDE");
  writeFileSync(join(home, "config.toml"), 'model = "ambient-model"\n');
  writeFileSync(join(home, "history.jsonl"), "{}\n");
  writeFileSync(join(home, "skills", "ambient", "SKILL.md"), "ambient skill");
  return home;
}
