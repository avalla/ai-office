/**
 * Project handover is the organizational transfer of a repository to the
 * virtual office: AI Office understands the project, records the management
 * state that belongs to its own domain, and can propose what to do next.
 *
 * Four concepts are deliberately kept apart:
 *
 * - discovery: deterministic repository evidence produced by the scanner;
 * - repository review: an agent reading the repository and comparing it with
 *   the stored state, then presenting the result to the user;
 * - user confirmation: the user accepting or correcting that review, which is
 *   the only thing that makes repository understanding authoritative;
 * - approved organizational model: the office manifest, which records mission,
 *   goals, constraints, preferences, roles, and pipelines.
 *
 * An approved office manifest never certifies repository understanding: it
 * carries no architecture, implementation state, or review acceptance.
 *
 * Handover is not an authorization concept. Nothing in this module grants a
 * capability, approves an action, or widens any policy decision.
 */

export type HandoverDimensionId =
  | "project_connection"
  | "repository_understanding"
  | "agent_clients"
  | "product_direction"
  | "delivery_plan"
  | "working_agreement";

/**
 * Explicit, coarse states. `unknown` is reserved for the case where the
 * authoritative runtime could not be consulted, so an honest answer is
 * impossible rather than merely negative.
 */
export type HandoverDimensionState =
  "unknown" | "not_started" | "discovered" | "needs_input" | "ready";

export type ProjectHandoverState =
  | "unknown"
  | "not_connected"
  | "not_imported"
  | "needs_handover"
  | "in_progress"
  | "ready";

export type RepositoryMaturity = "new" | "existing" | "unknown";

/**
 * Whether an explicit repository review has been confirmed for the repository
 * evidence AI Office currently holds.
 */
export type RepositoryReviewState = "not_reviewed" | "stale" | "current";

export type RecommendedActionKind = "conversational" | "command";

export type RecommendedActionPriority = "high" | "medium" | "low";

export interface RecommendedAction {
  id: string;
  kind: RecommendedActionKind;
  priority: RecommendedActionPriority;
  title: string;
  reason: string;
  command?: string;
  prompt?: string;
}

export interface HandoverDimension {
  id: HandoverDimensionId;
  title: string;
  state: HandoverDimensionState;
  detail: string;
}

/**
 * Structural repository signals used to classify maturity. `null` means the
 * recorded scan predates the signal, not that the signal is absent.
 */
export interface RepositorySignals {
  languageCount: number;
  frameworkCount: number;
  documentationCount: number;
  sourceFileCount: number | null;
  hasCommitHistory: boolean | null;
}

/**
 * The material repository facts a repository review is confirmed against. The
 * fingerprint built from them changes on structural change, not on every edit.
 */
export interface RepositoryUnderstandingFacts {
  languages: readonly string[];
  frameworks: readonly string[];
  databases: readonly string[];
  testing: readonly string[];
  documentation: readonly string[];
  packageManager: string | null;
  remoteUrl: string | null;
  sourceFileCount: number | null;
  hasCommitHistory: boolean | null;
}

/**
 * Open onboarding questions split by whether their answer is material to the
 * handover. Goal and constraint questions define product direction and the
 * working agreement, so they block readiness; preference and permission
 * questions stay advisory.
 */
export interface OpenHandoverQuestions {
  blocking: number;
  advisory: number;
}

/**
 * Management knowledge AI Office already owns for this project. Every field is
 * derived from authoritative runtime state, is used by this module, and none
 * of it duplicates repository content.
 */
export interface ProjectHandoverKnowledge {
  repositoryScanned: boolean;
  repositorySignals: RepositorySignals;
  repositoryReview: RepositoryReviewState;
  officeConfigured: boolean;
  goalCount: number;
  constraintCount: number;
  preferenceCount: number;
  milestoneTotal: number;
  activeMilestones: number;
  requirementTotal: number;
  tasksOpen: number;
  tasksInProgress: number;
  openQuestions: OpenHandoverQuestions;
}

export interface HandoverClientState {
  detected: boolean;
  configured: boolean;
}

export interface ProjectHandoverConnection {
  daemonReachable: boolean;
  repositoryIdentity: "missing" | "invalid" | "legacy" | "valid";
  runtimeAssociation:
    "missing" | "unverified" | "conflicting" | "project_missing" | "valid";
  authoritativeStateAvailable: boolean;
  officeManifestPresent: boolean;
  blockingIssueCount: number;
  clients: readonly HandoverClientState[];
}

export interface ProjectHandoverInput {
  connection: ProjectHandoverConnection;
  knowledge: ProjectHandoverKnowledge | null;
}

export interface ProjectHandoverAssessment {
  schemaVersion: 1;
  state: ProjectHandoverState;
  repository: RepositoryMaturity;
  openQuestions: OpenHandoverQuestions;
  dimensions: readonly HandoverDimension[];
  recommendedActions: readonly RecommendedAction[];
  suggestedPrompts: readonly string[];
}

export const maximumRecommendedActions = 4;
export const maximumSuggestedPrompts = 4;

const noOpenQuestions: OpenHandoverQuestions = Object.freeze({
  blocking: 0,
  advisory: 0,
});

const priorityOrder: Record<RecommendedActionPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const handoverPrompt =
  "Take this project in charge. Review the repository and the current AI Office state, then help me complete the project handover.";

const reviewPrompt =
  "Review this repository against what AI Office already knows, show me the result, and record the confirmed handover review.";

/**
 * Coarse size buckets keep the review fingerprint stable across ordinary edits
 * while still reacting to structural growth or removal.
 */
export function repositoryScaleBucket(count: number | null): string {
  if (count === null) return "unrecorded";
  if (count === 0) return "none";
  if (count < 10) return "tiny";
  if (count < 25) return "small";
  if (count < 100) return "medium";
  if (count < 500) return "large";
  return "very_large";
}

/**
 * Files AI Office itself installs as coding-client integration. They are not
 * repository documentation evidence, so installing them must not change the
 * repository fingerprint or its maturity classification.
 */
export const officeManagedDocumentationFiles: readonly string[] = Object.freeze(
  ["AI-OFFICE.md", "AGENTS.md", "CLAUDE.md", "CODEX.md"],
);

export function repositoryDocumentation(
  files: readonly string[],
): readonly string[] {
  return files.filter(
    (file) => !officeManagedDocumentationFiles.includes(file),
  );
}

function factList(values: readonly string[]): string {
  return [...values].sort().join(",");
}

/**
 * Deterministic, order-independent projection of the repository facts a review
 * was confirmed against. The caller hashes it; the domain stays free of
 * cryptography.
 */
export function repositoryUnderstandingFingerprintSource(
  facts: RepositoryUnderstandingFacts,
): string {
  return [
    "repository-understanding-v1",
    `languages=${factList(facts.languages)}`,
    `frameworks=${factList(facts.frameworks)}`,
    `databases=${factList(facts.databases)}`,
    `testing=${factList(facts.testing)}`,
    `documentation=${factList(facts.documentation)}`,
    `packageManager=${facts.packageManager ?? ""}`,
    `remote=${facts.remoteUrl ?? ""}`,
    `scale=${repositoryScaleBucket(facts.sourceFileCount)}`,
    `history=${facts.hasCommitHistory === null ? "unrecorded" : String(facts.hasCommitHistory)}`,
  ].join("\n");
}

/**
 * Deterministic repository-maturity heuristic based on the amount of existing
 * application code rather than on tooling presence: a fresh scaffold already
 * declares a language, a framework, and a package manager, while a long-lived
 * single-language repository may declare none of them.
 *
 * A repository counts as existing when it carries a substantial amount of
 * source code, or a moderate amount together with real commit history and more
 * than one documentation file. Without recorded file evidence the honest
 * answer is `unknown`; re-importing the repository records it.
 */
export function classifyRepositoryMaturity(
  signals: RepositorySignals,
): RepositoryMaturity {
  const sourceFiles = signals.sourceFileCount;
  if (sourceFiles === null) return "unknown";
  if (sourceFiles >= 25) return "existing";
  return sourceFiles >= 8 &&
    signals.hasCommitHistory === true &&
    signals.documentationCount >= 2
    ? "existing"
    : "new";
}

function dimension(
  id: HandoverDimensionId,
  title: string,
  state: HandoverDimensionState,
  detail: string,
): HandoverDimension {
  return { id, title, state, detail };
}

function unknownDimensions(detail: string): HandoverDimension[] {
  return [
    dimension("project_connection", "Project connection", "unknown", detail),
    dimension(
      "repository_understanding",
      "Repository understanding",
      "unknown",
      detail,
    ),
    dimension("agent_clients", "Agent clients", "unknown", detail),
    dimension("product_direction", "Product direction", "unknown", detail),
    dimension("delivery_plan", "Delivery plan", "unknown", detail),
    dimension("working_agreement", "Working agreement", "unknown", detail),
  ];
}

function connectionDimension(
  connection: ProjectHandoverConnection,
): HandoverDimension {
  if (connection.repositoryIdentity === "invalid")
    return dimension(
      "project_connection",
      "Project connection",
      "needs_input",
      "The repository identity file is invalid and must be repaired explicitly",
    );
  if (connection.repositoryIdentity === "missing")
    return dimension(
      "project_connection",
      "Project connection",
      "not_started",
      "This repository is not connected to an AI Office project",
    );
  if (connection.runtimeAssociation !== "valid")
    return dimension(
      "project_connection",
      "Project connection",
      "needs_input",
      `The runtime association is ${connection.runtimeAssociation}`,
    );
  if (!connection.officeManifestPresent)
    return dimension(
      "project_connection",
      "Project connection",
      "discovered",
      "The project is connected but no office manifest is configured",
    );
  return dimension(
    "project_connection",
    "Project connection",
    "ready",
    connection.repositoryIdentity === "legacy"
      ? "Connected through a legacy repository identity"
      : "Repository identity and runtime association are valid",
  );
}

function clientsDimension(
  connection: ProjectHandoverConnection,
): HandoverDimension {
  // An empty list means the clients were not inspected, not that none exist.
  if (connection.clients.length === 0)
    return dimension(
      "agent_clients",
      "Agent clients",
      "unknown",
      "Agent client integration was not inspected",
    );
  const configured = connection.clients.filter(
    (client) => client.configured,
  ).length;
  const detected = connection.clients.filter(
    (client) => client.detected,
  ).length;
  if (configured > 0)
    return dimension(
      "agent_clients",
      "Agent clients",
      "ready",
      `${configured} configured agent client${configured === 1 ? "" : "s"}`,
    );
  if (detected > 0)
    return dimension(
      "agent_clients",
      "Agent clients",
      "needs_input",
      "A supported agent client is installed but not configured for this repository",
    );
  return dimension(
    "agent_clients",
    "Agent clients",
    "not_started",
    "No supported agent client was detected",
  );
}

function discoveredEvidence(signals: RepositorySignals): string {
  const files =
    signals.sourceFileCount === null
      ? "source files not recorded"
      : `${signals.sourceFileCount} source file(s)`;
  return `${signals.languageCount} language(s), ${signals.frameworkCount} framework(s), ${signals.documentationCount} documentation file(s), ${files}`;
}

function understandingDimension(
  knowledge: ProjectHandoverKnowledge,
): HandoverDimension {
  if (!knowledge.repositoryScanned)
    return dimension(
      "repository_understanding",
      "Repository understanding",
      "not_started",
      "This repository has not been scanned into the project profile",
    );
  const evidence = discoveredEvidence(knowledge.repositorySignals);
  if (knowledge.repositoryReview === "not_reviewed")
    return dimension(
      "repository_understanding",
      "Repository understanding",
      "discovered",
      `Discovered ${evidence}; no confirmed handover repository review is recorded`,
    );
  if (knowledge.repositoryReview === "stale")
    return dimension(
      "repository_understanding",
      "Repository understanding",
      "needs_input",
      `Discovered ${evidence}; the repository changed materially since the confirmed review`,
    );
  return dimension(
    "repository_understanding",
    "Repository understanding",
    "ready",
    `Reviewed and confirmed against the current repository evidence: ${evidence}`,
  );
}

function directionDimension(
  knowledge: ProjectHandoverKnowledge,
): HandoverDimension {
  if (!knowledge.repositoryScanned)
    return dimension(
      "product_direction",
      "Product direction",
      "not_started",
      "No project evidence has been collected yet",
    );
  if (!knowledge.officeConfigured)
    return dimension(
      "product_direction",
      "Product direction",
      "needs_input",
      "The office still uses the default baseline; its mission and goals are not yours yet",
    );
  if (knowledge.goalCount === 0)
    return dimension(
      "product_direction",
      "Product direction",
      "needs_input",
      "The approved office records no product goal",
    );
  return dimension(
    "product_direction",
    "Product direction",
    "ready",
    `The approved office records ${knowledge.goalCount} goal${knowledge.goalCount === 1 ? "" : "s"}`,
  );
}

function deliveryDimension(
  knowledge: ProjectHandoverKnowledge,
): HandoverDimension {
  if (knowledge.activeMilestones > 0)
    return dimension(
      "delivery_plan",
      "Delivery plan",
      "ready",
      `${knowledge.activeMilestones} active milestone${knowledge.activeMilestones === 1 ? "" : "s"}, ${knowledge.requirementTotal} requirement(s)`,
    );
  if (knowledge.milestoneTotal > 0)
    return dimension(
      "delivery_plan",
      "Delivery plan",
      "discovered",
      `${knowledge.milestoneTotal} milestone(s) recorded, none active`,
    );
  if (knowledge.officeConfigured)
    return dimension(
      "delivery_plan",
      "Delivery plan",
      "needs_input",
      "No milestone has been proposed for this project",
    );
  return dimension(
    "delivery_plan",
    "Delivery plan",
    "not_started",
    "Delivery planning starts after the office is configured",
  );
}

/**
 * The working agreement is the approved office configuration. Project profile
 * evidence is separately sourced discovery and is never summed into it.
 */
function agreementDimension(
  knowledge: ProjectHandoverKnowledge,
): HandoverDimension {
  const detail = `The approved office records ${knowledge.constraintCount} constraint(s) and ${knowledge.preferenceCount} preference(s)`;
  if (!knowledge.officeConfigured)
    return dimension(
      "working_agreement",
      "Working agreement",
      "not_started",
      "Constraints and preferences still come from the default baseline",
    );
  return knowledge.constraintCount + knowledge.preferenceCount === 0
    ? dimension("working_agreement", "Working agreement", "needs_input", detail)
    : dimension("working_agreement", "Working agreement", "ready", detail);
}

function overallState(
  dimensions: readonly HandoverDimension[],
  knowledge: ProjectHandoverKnowledge,
): ProjectHandoverState {
  const byId = new Map(dimensions.map((item) => [item.id, item.state]));
  if (
    byId.get("project_connection") === "not_started" ||
    byId.get("project_connection") === "needs_input"
  )
    return "not_connected";
  if (byId.get("repository_understanding") === "not_started")
    return "not_imported";
  if (byId.get("product_direction") !== "ready") return "needs_handover";
  return dimensions.some((item) => item.state !== "ready") ||
    knowledge.openQuestions.blocking > 0
    ? "in_progress"
    : "ready";
}

function orderedActions(
  actions: readonly RecommendedAction[],
): readonly RecommendedAction[] {
  const seen = new Set<string>();
  const unique = actions.filter((action) => {
    if (seen.has(action.id)) return false;
    seen.add(action.id);
    return true;
  });
  return Object.freeze(
    unique
      .map((action, index) => ({ action, index }))
      .sort(
        (left, right) =>
          priorityOrder[left.action.priority] -
            priorityOrder[right.action.priority] || left.index - right.index,
      )
      .slice(0, maximumRecommendedActions)
      .map((entry) => entry.action),
  );
}

/**
 * The repository identity is valid but the runtime cannot be consulted, so no
 * management dimension can be reported honestly. Existing handover state is
 * neither claimed nor denied.
 */
function unavailableAssessment(): ProjectHandoverAssessment {
  const detail =
    "The AI Office runtime is unreachable, so the handover state cannot be read";
  return {
    schemaVersion: 1,
    state: "unknown",
    repository: "unknown",
    openQuestions: noOpenQuestions,
    dimensions: Object.freeze(unknownDimensions(detail)),
    recommendedActions: Object.freeze([
      {
        id: "start_runtime",
        kind: "command" as const,
        priority: "high" as const,
        title: "Start the AI Office runtime",
        reason: detail,
        command: "ai-office daemon",
      },
    ]),
    suggestedPrompts: Object.freeze([
      "Start the AI Office runtime and tell me what this project still needs.",
    ]),
  };
}

function notConnectedAssessment(
  connection: ProjectHandoverConnection,
  connectionState: HandoverDimension,
): ProjectHandoverAssessment {
  const invalid = connection.repositoryIdentity === "invalid";
  return {
    schemaVersion: 1,
    state: "not_connected",
    repository: "unknown",
    openQuestions: noOpenQuestions,
    dimensions: Object.freeze([
      connectionState,
      dimension(
        "repository_understanding",
        "Repository understanding",
        "not_started",
        "AI Office has not scanned this repository",
      ),
      clientsDimension(connection),
      dimension(
        "product_direction",
        "Product direction",
        "not_started",
        "AI Office holds no management state for this repository",
      ),
      dimension(
        "delivery_plan",
        "Delivery plan",
        "not_started",
        "AI Office holds no management state for this repository",
      ),
      dimension(
        "working_agreement",
        "Working agreement",
        "not_started",
        "AI Office holds no management state for this repository",
      ),
    ]),
    recommendedActions: Object.freeze([
      {
        id: invalid ? "repair_project_connection" : "install_project",
        kind: "command" as const,
        priority: "high" as const,
        title: invalid
          ? "Repair the repository identity"
          : "Connect this repository to AI Office",
        reason: connectionState.detail,
        command: invalid ? "ai-office status" : "ai-office install .",
      },
    ]),
    suggestedPrompts: Object.freeze([
      "Set up AI Office for this repository and explain what it will manage.",
    ]),
  };
}

/**
 * Recommended actions in a fixed priority order: blocking lifecycle
 * correctness, unresolved handover, existing work, planning gaps, then
 * optional improvements. Equal priorities keep this insertion order.
 */
function recommendedActions(
  connection: ProjectHandoverConnection,
  knowledge: ProjectHandoverKnowledge,
  dimensions: readonly HandoverDimension[],
  state: ProjectHandoverState,
  repository: RepositoryMaturity,
): readonly RecommendedAction[] {
  const byId = new Map(dimensions.map((item) => [item.id, item]));
  const actions: RecommendedAction[] = [];

  if (connection.blockingIssueCount > 0)
    actions.push({
      id: "resolve_lifecycle_issues",
      kind: "command",
      priority: "high",
      title: "Resolve the reported lifecycle issues",
      reason: `${connection.blockingIssueCount} blocking issue(s) are reported by status`,
      command: "ai-office status",
    });

  if (state === "not_imported")
    actions.push({
      id: "import_repository",
      kind: "command",
      priority: "high",
      title: "Import this repository into AI Office",
      reason: "No repository scan has been recorded for this project",
      command: "ai-office project:import .",
    });
  else if (state === "needs_handover")
    actions.push({
      id: "complete_project_handover",
      kind: "conversational",
      priority: "high",
      title: "Hand this project over to your virtual office",
      reason:
        repository === "existing"
          ? "AI Office scanned an existing codebase but has neither a confirmed repository review nor approved product context for it"
          : "AI Office has no approved product context for this project",
      prompt: handoverPrompt,
    });
  else if (knowledge.repositoryReview === "not_reviewed")
    actions.push({
      id: "confirm_repository_review",
      kind: "conversational",
      priority: "high",
      title: "Confirm the handover repository review",
      reason:
        "The office holds an approved organizational model but no confirmed review of this repository",
      prompt: reviewPrompt,
    });
  else if (knowledge.repositoryReview === "stale")
    actions.push({
      id: "review_repository_changes",
      kind: "conversational",
      priority: "high",
      title: "Review the repository changes since the last handover",
      reason: byId.get("repository_understanding")!.detail,
      prompt:
        "The repository changed since the last handover review. Compare it with the AI Office state and confirm the updated review.",
    });

  if (knowledge.openQuestions.blocking > 0)
    actions.push({
      id: "answer_open_questions",
      kind: "conversational",
      priority: "high",
      title: `Complete ${knowledge.openQuestions.blocking} remaining project question(s)`,
      reason:
        "Open goal or constraint questions describe context the handover still needs",
      prompt:
        "Show me the open AI Office project questions and help me answer the ones that matter.",
    });

  if (knowledge.tasksOpen > 0)
    actions.push({
      id: "review_active_work",
      kind: "command",
      priority: state === "ready" ? "high" : "medium",
      title:
        knowledge.tasksInProgress > 0
          ? `Review ${knowledge.tasksInProgress} task(s) in progress`
          : `Review ${knowledge.tasksOpen} open task(s)`,
      reason:
        "Work the office already tracks should be reviewed before new work starts",
      command: "ai-office task:list",
    });

  if (byId.get("delivery_plan")?.state === "needs_input")
    actions.push({
      id: "plan_next_milestone",
      kind: "conversational",
      priority: "medium",
      title: "Propose the next milestone",
      reason: byId.get("delivery_plan")!.detail,
      prompt:
        "Assess this project with AI Office and propose the next milestone and its requirements before we start work.",
    });

  if (byId.get("delivery_plan")?.state === "discovered")
    actions.push({
      id: "activate_milestone",
      kind: "conversational",
      priority: "medium",
      title: "Activate a milestone",
      reason: byId.get("delivery_plan")!.detail,
      prompt:
        "Show me the recorded milestones and help me decide which one the office should work on next.",
    });

  if (byId.get("working_agreement")?.state === "needs_input")
    actions.push({
      id: "record_working_agreement",
      kind: "conversational",
      priority: "medium",
      title: "Record how the office should work on this project",
      reason: byId.get("working_agreement")!.detail,
      prompt:
        "Help me record the constraints and working preferences the office must respect in this project.",
    });

  if (state === "ready")
    actions.push({
      id: "start_next_work",
      kind: "conversational",
      priority: "medium",
      title: "Describe what you want to achieve next",
      reason: "The office is ready to assess and plan new work",
      prompt:
        "Here is what I want to build next. Let the office assess it against the current roadmap before we start.",
    });

  if (byId.get("agent_clients")?.state === "needs_input")
    actions.push({
      id: "reconcile_agent_clients",
      kind: "command",
      priority: "low",
      title: "Configure the detected agent client",
      reason: byId.get("agent_clients")!.detail,
      command: "ai-office install .",
    });

  return orderedActions(actions);
}

function suggestedPrompts(
  state: ProjectHandoverState,
  knowledge: ProjectHandoverKnowledge,
): readonly string[] {
  const prompts: string[] = [];
  if (state === "not_imported" || state === "needs_handover")
    prompts.push(handoverPrompt);
  if (state === "in_progress")
    prompts.push(
      "Continue the project handover: tell me what AI Office still needs from me.",
    );
  prompts.push(
    "Review the current project and tell me what the office thinks we should do next.",
  );
  prompts.push("Show me the current roadmap, milestones and active work.");
  if (knowledge.tasksOpen > 0)
    prompts.push(
      "Summarize the work already tracked by the office and whether it still matches the roadmap.",
    );
  else
    prompts.push(
      "I want to implement a new capability. Let the office assess it before starting.",
    );
  return prompts.slice(0, maximumSuggestedPrompts);
}

export function assessProjectHandover(
  input: ProjectHandoverInput,
): ProjectHandoverAssessment {
  const { connection, knowledge } = input;
  const connectionState = connectionDimension(connection);
  // A repository with no usable identity is genuinely not connected, and that
  // is knowable without the runtime. Anything beyond it is not: when the
  // runtime cannot be consulted the honest answer is `unknown`, never advice
  // to reinstall a project that may already be fully handed over.
  if (
    connection.repositoryIdentity === "missing" ||
    connection.repositoryIdentity === "invalid"
  )
    return notConnectedAssessment(connection, connectionState);
  if (!connection.daemonReachable) return unavailableAssessment();
  if (!connection.authoritativeStateAvailable || knowledge === null)
    return notConnectedAssessment(connection, connectionState);

  const dimensions: readonly HandoverDimension[] = Object.freeze([
    connectionState,
    understandingDimension(knowledge),
    clientsDimension(connection),
    directionDimension(knowledge),
    deliveryDimension(knowledge),
    agreementDimension(knowledge),
  ]);
  const state = overallState(dimensions, knowledge);
  const repository = knowledge.repositoryScanned
    ? classifyRepositoryMaturity(knowledge.repositorySignals)
    : "unknown";
  const actions = recommendedActions(
    connection,
    knowledge,
    dimensions,
    state,
    repository,
  );
  const shown = new Set(
    actions
      .map((action) => action.prompt)
      .filter((prompt): prompt is string => prompt !== undefined),
  );
  return {
    schemaVersion: 1,
    state,
    repository,
    openQuestions: knowledge.openQuestions,
    dimensions,
    recommendedActions: actions,
    suggestedPrompts: Object.freeze(
      suggestedPrompts(state, knowledge).filter((prompt) => !shown.has(prompt)),
    ),
  };
}
