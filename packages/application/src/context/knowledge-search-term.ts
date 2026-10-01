/**
 * Compatibility term retained from the former CairnKeep literal-substring search.
 * The caller selects this term before calling AgentKnowledgeStore.findKnowledge;
 * the store itself searches exactly the supplied literal text.
 */
const substringStopWords = new Set([
  "about", "after", "and", "before", "for", "from", "into", "that", "the",
  "then", "this", "use", "when", "with", "without", "add", "adds", "allow",
  "analyse", "analyze", "build", "change", "check", "clean", "cleanup",
  "create", "delete", "design", "disable", "document", "enable", "ensure",
  "explain", "fix", "handle", "implement", "improve", "introduce",
  "investigate", "make", "migrate", "move", "prevent", "refactor",
  "remove", "rename", "review", "support", "test", "tests", "tune",
  "update", "upgrade", "validate", "write",
]);

export function knowledgeCompatibilitySearchTerm(query: string): string {
  let best = "";
  for (const match of query
    .toLowerCase()
    .matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)) {
    const term = match[0];
    const length = [...term].length;
    if (length < 3 || substringStopWords.has(term)) continue;
    if (length > [...best].length) best = term;
  }
  return best === "" ? query : best;
}
