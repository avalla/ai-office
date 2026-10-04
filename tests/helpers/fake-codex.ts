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

export type FakeCodexMode =
  | "ok"
  | "fail"
  | "hang"
  | "tool"
  | "linger"
  | "reconnect"
  | "gave-up"
  | "unauthorized"
  | "spawn";

export interface FakeCodexReport {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  cwdEntries: string[];
  home: { entries: string[]; mode: number };
  codexHome: { entries: string[]; mode: number };
  auth: { content: string; mode: number } | null;
  prompt: string;
  /** Skills the audited CLI would load from a discovered project root. */
  projectSkills: string[];
}

/** A JWT-shaped token carrying only the claims the worker and CLI read. */
export function codexToken(
  plan: unknown,
  /** `exp` in seconds, far in the future by default; `null` omits it. */
  exp: unknown = 4102444800,
): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    part({ alg: "none", typ: "JWT" }),
    part({
      ...(exp === null ? {} : { exp }),
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-fixture",
        ...(plan === undefined ? {} : { chatgpt_plan_type: plan }),
      },
    }),
    "c2lnbmF0dXJl",
  ].join(".");
}

/** A file-backed ChatGPT login as codex-cli 0.160.0 stores it. */
export function codexLogin(
  plan: unknown,
  secret: string,
  /** `exp` of the access token in seconds; `null` omits the claim. */
  accessExp: unknown = 4102444800,
): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: codexToken(plan),
      access_token: codexToken(plan, accessExp),
      refresh_token: secret,
      account_id: "account-fixture",
    },
    last_refresh: "2026-10-01T00:00:00.000000000Z",
  });
}

/**
 * Plans for which codex-cli 0.160.0 was observed to download a
 * workspace-managed configuration bundle once authenticated.
 */
export const managedBundlePlans = [
  "business",
  "ent26",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "enterprise",
  "hc",
  "edu",
  "education",
  "edu_pro",
] as const;

/** Models whose bundled 0.160.0 metadata declares `multi_agent_version: "v2"`. */
export const multiAgentV2Models = [
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-daybreak-blue-latest",
  "gpt-daybreak-red-latest",
] as const;

/**
 * A stand-in `codex` executable that records the environment, working
 * directory and Codex home it was started with before answering.
 */
export function installFakeCodex(
  root: string,
  /** Origin of a stand-in ChatGPT backend serving `/wham/config/bundle`. */
  backend?: string,
) {
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
const calls = ${JSON.stringify(join(root, "codex-calls.log"))};
fs.appendFileSync(calls, args[0] + "\\n");
if (args[0] === "--version") { console.log("codex-cli 0.160.0"); process.exit(0); }
const authFile = path.join(process.env.CODEX_HOME ?? "", "auth.json");
const claimsOf = (token) => { try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); } catch { return {}; } };
let login = (() => { try { return JSON.parse(fs.readFileSync(authFile, "utf8")); } catch { return null; } })();
// What 0.160.0 does with a login before anything else: refresh an access
// token within five minutes of its expiry, or one the provider rejects with
// 401, at CODEX_REFRESH_TOKEN_URL_OVERRIDE or else at its issuer, then store
// and use the tokens it gets back.
const authenticated = login !== null && (args[0] === "features" || args[0] === "exec");
const stale = authenticated && (claimsOf(login.tokens?.access_token ?? "").exp ?? 0) * 1000 < Date.now() + 5 * 60 * 1000;
const rejected = args[0] === "exec" && fs.readFileSync(${JSON.stringify(modePath)}, "utf8").trim() === "unauthorized";
if (authenticated && (stale || rejected)) {
  const target = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ?? ${JSON.stringify((backend ?? "http://127.0.0.1:0") + "/oauth/token")};
  fs.appendFileSync(${JSON.stringify(join(root, "codex-refresh.log"))}, target + "\\n");
  try {
    const refreshed = await (await fetch(target, { method: "POST" })).json();
    login = { ...login, tokens: { ...login.tokens, ...refreshed } };
    fs.writeFileSync(authFile, JSON.stringify(login));
  } catch {
    console.error("Failed to refresh token: error sending request for url (" + target + ")");
    process.exit(1);
  }
}
// And once it holds a login of a managed plan: download the workspace
// configuration bundle and start the MCP servers it defines.
const plan = claimsOf(login?.tokens?.id_token ?? "")["https://api.openai.com/auth"]?.chatgpt_plan_type;
if (${JSON.stringify(backend ?? "")} !== "" && ${JSON.stringify(managedBundlePlans)}.includes(plan) && (args[0] === "features" || args[0] === "exec")) {
  const bundle = await (await fetch(${JSON.stringify(backend ?? "")} + "/backend-api/wham/config/bundle")).json();
  for (const fragment of bundle.config_toml?.enterprise_managed ?? []) {
    const command = /^command = (".*")$/m.exec(fragment.contents);
    const argv = /^args = (\\[.*\\])$/m.exec(fragment.contents);
    if (command !== null) require("node:child_process").spawnSync(JSON.parse(command[1]), argv === null ? [] : JSON.parse(argv[1]), { stdio: "ignore" });
  }
}
if (args[0] === "features") {
  const off = new Set(args.filter((_, i) => args[i - 1] === "--disable"));
  const lines = fs.readFileSync(${JSON.stringify(listingPath)}, "utf8").split("\\n");
  for (const name of off) if (!lines.some((line) => line.split(/\\s+/)[0] === name)) { console.error("Error: Unknown feature flag: " + name); process.exit(1); }
  console.log(lines.map((line) => { const name = line.split(/\\s+/)[0]; return off.has(name) && name !== "unified_exec" ? line.replace(/true$/, "false") : line; }).join("\\n"));
  process.exit(0);
}
if (args[0] !== "exec") process.exit(1);
const mode = fs.readFileSync(${JSON.stringify(modePath)}, "utf8").trim();
const names = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
const list = (dir) => ({ entries: fs.readdirSync(dir).sort(), mode: fs.statSync(dir).mode & 0o777 });
const authPath = path.join(process.env.CODEX_HOME, "auth.json");
const auth = fs.existsSync(authPath) ? { content: fs.readFileSync(authPath, "utf8"), mode: fs.statSync(authPath).mode & 0o777 } : null;
const prompt = await Bun.stdin.text();
// ".bun" in HOME is this stand-in's own interpreter cache, not client state.
// Project discovery as codex-cli 0.160.0 does it: walk up from the working
// directory to the first ancestor holding a root marker (".git" by default,
// file or directory) and load its skills. project_root_markers=[] turns it off.
const config = args.filter((_, i) => args[i - 1] === "--config" || args[i - 1] === "-c");
const markers = config.includes("project_root_markers=[]") ? [] : [".git"];
const projectSkills = [];
for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
  if (markers.some((marker) => fs.existsSync(path.join(dir, marker)))) {
    for (const skills of [".agents/skills", ".codex/skills"])
      for (const name of names(path.join(dir, skills))) projectSkills.push(path.join(dir, skills, name));
    break;
  }
  if (path.dirname(dir) === dir) break;
}
fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ args, env: process.env, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()).sort(), home: { ...list(process.env.HOME), entries: list(process.env.HOME).entries.filter((name) => name !== ".bun") }, codexHome: list(process.env.CODEX_HOME), auth, prompt, projectSkills }));
// A real client writes session state into its home; cleanup must remove it.
fs.writeFileSync(path.join(process.env.CODEX_HOME, "state.sqlite"), "state");
if (mode === "fail") { console.error("login failed for " + (auth === null ? "nobody" : auth.content)); process.exit(1); }
if (mode === "spawn") {
  // What 0.160.0 does when the model calls spawn_agent: for a model whose
  // metadata (bundled, or supplied by the provider) declares multi-agent v2
  // it starts a child that talks to the provider on a model and effort of the
  // parent's choosing, and prints nothing about it. Only agents.enabled=false
  // makes it refuse the call.
  const routed = args[args.indexOf("--model") + 1];
  const declared = ${JSON.stringify(multiAgentV2Models)}.includes(routed) || fs.existsSync(${JSON.stringify(join(root, "codex-provider-multi-agent"))});
  if (declared && !config.includes("agents.enabled=false"))
    await fetch(${JSON.stringify((backend ?? "http://127.0.0.1:0") + "/v1/responses")}, { method: "POST", body: JSON.stringify({ model: "gpt-6-luna", reasoning: { effort: "xhigh" }, parent: routed }) }).catch(() => {});
}
if (mode === "hang") { setInterval(() => {}, 1000); await new Promise(() => {}); }
if (mode === "linger") {
  // A helper that outlives a successful parent and keeps writing its home.
  const helper = require("node:child_process").spawn(process.execPath, ["-e", "const fs = require('node:fs'); const path = require('node:path'); setInterval(() => { try { const dir = path.join(process.env.CODEX_HOME, 'sessions'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, String(Date.now())), 'x'); } catch {} }, 1);"], { stdio: "ignore" });
  helper.unref();
  fs.writeFileSync(${JSON.stringify(join(root, "codex-helper.pid"))}, String(helper.pid));
  await Bun.sleep(50);
}
const events = [
  { type: "thread.started", thread_id: "fixture-thread" },
  { type: "item.completed", item: { id: "item_0", type: "error", message: "Code Mode is unavailable because code-mode host is disabled." } },
  { type: "turn.started" },
  ...(mode === "reconnect" || mode === "gave-up" ? [{ type: "error", message: "Reconnecting... 1/5 (stream disconnected before completion: error sending request)" }, { type: "error", message: "Reconnecting... 2/5 (stream disconnected before completion: error sending request)" }] : []),
  ...(mode === "tool" ? [{ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "cat /etc/passwd" } }] : []),
  { type: "item.completed", item: { id: "item_2", type: "agent_message", text: JSON.stringify({ summary: "Codex analysis", content: "Explicit context only" }) } },
  { type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 } },
];
if (mode === "gave-up") {
  events.splice(-2, 2, { type: "error", message: "stream disconnected before completion" }, { type: "turn.failed", error: { message: "stream disconnected before completion" } });
  for (const event of events) console.log(JSON.stringify(event));
  process.exit(1);
}
for (const event of events) console.log(JSON.stringify(event));
process.exit(0);
`,
    { mode: 0o700 },
  );
  return {
    bin,
    executable,
    setMode: (mode: FakeCodexMode) => writeFileSync(modePath, mode),
    setFeatureListing: (listing: string) => writeFileSync(listingPath, listing),
    /** Every invocation's first argument, in order; empty when none ran. */
    calls: () => {
      try {
        return readFileSync(join(root, "codex-calls.log"), "utf8")
          .trim()
          .split("\n");
      } catch {
        return [];
      }
    },
    /** Provider metadata now declares multi-agent v2 for every model. */
    provideMultiAgentMetadata: () =>
      writeFileSync(join(root, "codex-provider-multi-agent"), ""),
    /** Every URL at which the client tried to refresh its login. */
    refreshAttempts: () => {
      try {
        return readFileSync(join(root, "codex-refresh.log"), "utf8")
          .trim()
          .split("\n");
      } catch {
        return [];
      }
    },
    helperPid: () =>
      Number(readFileSync(join(root, "codex-helper.pid"), "utf8")),
    report: () =>
      JSON.parse(readFileSync(reportPath, "utf8")) as FakeCodexReport,
  };
}

/** An operator Codex home holding a login plus state the worker must not see. */
export function createOperatorCodexHome(
  root: string,
  secret: string,
  plan: unknown = "pro",
): string {
  const home = join(root, "operator-codex-home");
  mkdirSync(join(home, "skills", "ambient"), { recursive: true });
  writeFileSync(join(home, "auth.json"), codexLogin(plan, secret), {
    mode: 0o600,
  });
  writeFileSync(join(home, "AGENTS.md"), "AMBIENT GLOBAL INSTRUCTIONS");
  writeFileSync(join(home, "AGENTS.override.md"), "AMBIENT OVERRIDE");
  writeFileSync(join(home, "config.toml"), 'model = "ambient-model"\n');
  writeFileSync(join(home, "history.jsonl"), "{}\n");
  writeFileSync(join(home, "skills", "ambient", "SKILL.md"), "ambient skill");
  return home;
}
