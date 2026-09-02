/**
 * Project handover is the organizational transfer of a repository to the
 * virtual office: AI Office understands the project, records the management
 * state that belongs to its own domain, and can propose what to do next.
 *
 * Handover is deliberately not an authorization concept. Nothing in this module
 * grants a capability, approves an action, or widens any policy decision.
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

export interface RepositorySignals {
  languageCount: number;
  frameworkCount: number;
  documentationCount: number;
  testingCount: number;
  hasPackageManager: boolean;
  hasGitHistory: boolean;
}

/**
 * Management knowledge AI Office already owns for this project. Every field is
 * derived from authoritative runtime state; none of it duplicates repository
 * content.
 */
export interface ProjectHandoverKnowledge {
  repositoryScanned: boolean;
  repositorySignals: RepositorySignals;
  officeConfigured: boolean;
  mission: string | null;
  goalCount: number;
  constraintCount: number;
  preferenceCount: number;
  roleCount: number;
  userGoalCount: number;
  userConstraintCount: number;
  openQuestionCount: number;
  milestoneTotal: number;
  activeMilestones: number;
  requirementTotal: number;
  taskTotal: number;
  tasksOpen: number;
  tasksInProgress: number;
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
  dimensions: readonly HandoverDimension[];
  recommendedActions: readonly RecommendedAction[];
  suggestedPrompts: readonly string[];
}

export const maximumRecommendedActions = 4;
export const maximumSuggestedPrompts = 4;

const priorityOrder: Record<RecommendedActionPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const handoverPrompt =
  "Take this project in charge. Review the repository and the current AI Office state, then help me complete the project handover.";

/**
 * Deterministic repository-maturity heuristic. A repository counts as existing
 * when at least two independent structural signals are present, so a single
 * README or an empty scaffold is not mistaken for an established codebase.
 */
export function classifyRepositoryMaturity(
  signals: RepositorySignals,
): "new" | "existing" {
  const score = [
    signals.languageCount > 0,
    signals.frameworkCount > 0,
    signals.testingCount > 0,
    signals.hasPackageManager,
    signals.documentationCount > 1,
  ].filter(Boolean).length;
  return score >= 2 ? "existing" : "new";
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
  const signals = knowledge.repositorySignals;
  const detail = `Scanned: ${signals.languageCount} language(s), ${signals.frameworkCount} framework(s), ${signals.documentationCount} documentation file(s)`;
  return knowledge.officeConfigured
    ? dimension(
        "repository_understanding",
        "Repository understanding",
        "ready",
        `${detail}; confirmed through an approved office manifest`,
      )
    : dimension(
        "repository_understanding",
        "Repository understanding",
        "discovered",
        `${detail}; not yet confirmed with you`,
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
      "The office still uses the default baseline; goals and mission are not yours yet",
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
    `Mission and ${knowledge.goalCount} goal${knowledge.goalCount === 1 ? "" : "s"} are recorded`,
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

function agreementDimension(
  knowledge: ProjectHandoverKnowledge,
): HandoverDimension {
  const recorded =
    knowledge.constraintCount +
    knowledge.preferenceCount +
    knowledge.userConstraintCount;
  if (!knowledge.officeConfigured)
    return dimension(
      "working_agreement",
      "Working agreement",
      "not_started",
      "Constraints and preferences still come from the default baseline",
    );
  if (recorded === 0)
    return dimension(
      "working_agreement",
      "Working agreement",
      "needs_input",
      "The approved office records no constraint or working preference",
    );
  return dimension(
    "working_agreement",
    "Working agreement",
    "ready",
    `${knowledge.constraintCount} constraint(s) and ${knowledge.preferenceCount} preference(s) recorded`,
  );
}

function overallState(
  dimensions: readonly HandoverDimension[],
): ProjectHandoverState {
  const byId = new Map(dimensions.map((item) => [item.id, item.state]));
  if (byId.get("project_connection") === "not_started") return "not_connected";
  if (byId.get("project_connection") === "needs_input") return "not_connected";
  if (byId.get("repository_understanding") === "not_started")
    return "not_imported";
  if (byId.get("product_direction") !== "ready") return "needs_handover";
  return dimensions.some((item) => item.state !== "ready")
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
  const state = overallState(dimensions);
  const repository = knowledge.repositoryScanned
    ? classifyRepositoryMaturity(knowledge.repositorySignals)
    : "unknown";
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
          ? "AI Office scanned an existing codebase but has no approved product context for it"
          : "AI Office has no approved product context for this project",
      prompt: handoverPrompt,
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

  if (
    byId.get("product_direction")?.state === "needs_input" &&
    state !== "needs_handover"
  )
    actions.push({
      id: "define_product_goals",
      kind: "conversational",
      priority: "medium",
      title: "Record the product goals",
      reason: byId.get("product_direction")!.detail,
      prompt:
        "Review what AI Office knows about this project and help me record its mission, goals and constraints.",
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
      priority: "low",
      title: "Record how the office should work on this project",
      reason: byId.get("working_agreement")!.detail,
      prompt:
        "Help me record the constraints and working preferences the office must respect in this project.",
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

  const recommendedActions = orderedActions(actions);
  const shown = new Set(
    recommendedActions
      .map((action) => action.prompt)
      .filter((prompt): prompt is string => prompt !== undefined),
  );
  return {
    schemaVersion: 1,
    state,
    repository,
    dimensions,
    recommendedActions,
    suggestedPrompts: Object.freeze(
      suggestedPrompts(state, knowledge).filter((prompt) => !shown.has(prompt)),
    ),
  };
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
  return Object.freeze(prompts.slice(0, maximumSuggestedPrompts));
}
