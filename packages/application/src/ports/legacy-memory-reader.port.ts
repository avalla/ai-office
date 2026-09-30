/** A bounded snapshot of one explicitly named CairnKeep scope. */
export interface LegacyMemoryEntry {
  readonly key: string;
  readonly value: string;
}

export interface LegacyMemoryReader {
  readNamedScope(scope: string): Promise<readonly LegacyMemoryEntry[]>;
}
