export const runtimeCommandHelp = `AI Office CLI

Commands:
  install [path] [--rebind] [--json]
    reconciles repository identity, shared AI-OFFICE.md guidance, and detected host skills
    exit 0: installed; exit 2: installed with warnings; exit 1: failed/partial
  status [path] [--offline] [--json]
    exit 0: nothing needing attention found; exit 1: problem found or not installed
    --offline inspects repository-local evidence only and does not contact the
    Runtime, so it reports host state as not_checked, never as unreachable
  next [path] [--json]
    reports project handover readiness and the recommended next action
    exit 0: assessed; exit 1: authoritative state unavailable
  handover:confirm --project <id> --summary <text> [--json]
    records a confirmed handover repository review; evidence only, grants nothing
  uninstall [path] [--approve <plan-hash>] [--json]
  runtime start   # foreground persistent host; linkable ai-office entry point
  runtime status
  daemon          # compatibility alias for runtime start
  daemon:health   # compatibility alias for runtime status
  dashboard [--port <port>] [--host <loopback-address>] [--no-open]
    serves the read-only operations console on loopback until interrupted;
    requires a running daemon and prints the URL carrying the session token
  project:create <name> [--description <description>] [--json]
  project:import [path] [--name <name>] [--json]
  project:answer --project <id> --question <id> --answer <value>  # legacy stored questions only
  project:profile --project <id>
  project:export --project <id>
  project:backup --project <id> --output <path.aioffice> [--json]
  project:restore <archive.aioffice> [--root <path>] [--json]
  office:context --project <id>
  office:validate (--file <path> [--root <path>] | --manifest <json>)
    --file is canonically contained in the nearest binding/Git root from --root
    (--root defaults to caller cwd; standalone directories use that directory)
  office:apply --project <id> (--file <path> | --manifest <json>)
  office:show --project <id>
  office:pipeline --project <id> --task-kind <feature|bugfix|maintenance|research|release>
  pipeline:start --project <id> --task <id> --pipeline <id> [--actor-label <label>]
  pipeline:status --project <id> [--run <id>]
  pipeline:assign --project <id> --run <id> --agent <id> [--actor-label <label>]
  pipeline:transition --project <id> [--run <id>] --event <complete|approve|reject|cancel> [--agent-run <id>] [--actor-label <label>] [--rationale <text>]
  pipeline:override --project <id> --run <id> --reason <text> [--actor-label <label>]
  client:detect [--client <codex|claude>]
  client:inspect --client <codex|claude> --root <path>
  client:plan --client <codex|claude> --root <path> --contract <file>
  client:apply --client <codex|claude> --root <path> --contract <file> --approve <plan-hash>
  client:validate --client <codex|claude> --root <path>
  client:uninstall --client <codex|claude> --root <path> [--approve <plan-hash>]
  runtime:purge [--approve <plan-hash>]  # local; daemon must be stopped
  task:create --project <id> --title <title> [--description <description>] [--priority <integer>]
  task:list --project <id>
  task:transitions --project <id> --task <id> [--json]   # read-only preflight
  task:start --project <id> --task <id>
  task:submit-review --project <id> --task <id>
  task:complete --project <id> --task <id>
  task:block --project <id> --task <id> --reason <text>
  task:unblock --project <id> --task <id>
  task:fail --project <id> --task <id> --reason <text>
  task:cancel --project <id> --task <id> [--reason <text>]
  task:record-completion --project <id> --task <id> --reason <text> [--approve <plan-hash>] [--json]  # historical correction; read-only preflight without --approve
  task:link-requirement --project <id> --task <id> --requirement <id>
  task:unlink-requirement --project <id> --task <id> --requirement <id>
  task:reconcile --project <id> [--json]  # read-only; add --fix --approve <planHash> to repair
  agent:sync --project <id> [--directory <path>]
  agent:list --project <id>
  run:schedule --project <id> --task <id> --agent <id> [--resource <id> --operation <name> [--arguments <json>]]
  run:tick --project <id> [--capacity <1-100>] [--json]
  run:list --project <id>
  run:show --project <id> --run <id>
  pricing:set --provider <id> --model <id> --currency <USD|EUR> --input <micros> --cached-input <micros> --output <micros> --reasoning <micros>
  budget:set --project <id> --limit <micros> [--currency <USD|EUR>]
  cost:list --project <id> [--group-by <project|task|agent|agent_run>]
  milestone:create --project <id> --title <title> [--description <description>]
  milestone:set-status --project <id> --milestone <id> --status <status>
  requirement:create --project <id> --key <key> --title <title> --description <description> [--milestone <id>]
  requirement:set-status --project <id> --requirement <id> --status <status>
  adr:create --project <id> --title <title> --context <text> --decision <text> --consequences <text>
  adr:set-status --project <id> --adr <id> --status <status>
  review:create --project <id> --subject-type <type> --subject <id> --reviewer <name>
  review:decide --project <id> --review <id> --actor <name> --decision <approved|rejected> [--rationale <text>]
  governance:profile --project <id>
  governance:export --project <id>
  memory:role:create --name <name> --key <key> --version <n> --model-policy <policy> --max-iterations <n> --max-cost <micros> --timeout <seconds> [--description <text>] [--responsibilities <csv>] [--capabilities <csv>] [--tools <csv>]
  memory:pattern:create --name <name> --version <n> --problem <text> --context <text> --solution <text> [--id <id>] [--source-project <id>] [--applicability <csv>] [--constraints <csv>] [--risks <csv>]
  memory:lesson:create --title <title> --content <text> --confidence <0..1> [--source-project <id> --source-task <id>]
  memory:search --query <text> [--limit <1..100>] [--json]
  memory:pattern:adopt --project <id> --pattern <id> --version <n> [--query <text>]
  memory:references --project <id> [--json]
  memory:deprecate --type <role|pattern|lesson> --id <id> [--version <n>]  # version required for roles and patterns
  resource:create --project <id> --type <type> --provider <fake|filesystem> --name <name> [--external-ref <absolute-root>] [--configuration <json>]
  resource:list --project <id>
  resource:disable --project <id> --resource <id>
  capability:grant --project <id> --principal-type <type> --principal <id> --resource <id> --actions <csv> --granted-by <id> --reason <text> [--constraints <json>] [--valid-from <iso>] [--expires-at <iso>]
  capability:list --project <id>
  capability:revoke --project <id> --grant <id> --revoked-by <id>
  action:request --project <id> --agent <id> --resource <id> --operation <name> [--arguments <json>]
  action:invoke --project <id> (--action <id> | --agent <id> --resource <id> --operation <name> [--arguments <json>])
  action:approve --project <id> --action <id> --actor <audit-identity>
  action:reject --project <id> --action <id> --actor <audit-identity>
  action:execute --project <id> --action <id>
  action:list --project <id>
  action:show --project <id> --action <id>

Environment (linkable ai-office entry point):
  AI_OFFICE_HOME  runtime data home; defaults to ~/.ai-office`;
