/** Complete visible entries from one explicitly named CairnKeep scope. */
export interface LegacyMemoryEntry {
  readonly key: string;
  readonly value: string;
}

export const legacyMemoryLimits = {
  entries: 32,
  sourceBytes: 16_384,
  keyCharacters: 256,
  valueCharacters: 4_000,
  valueBytes: 16_384,
  serializedPlanBytes: 32_768,
} as const;

export function isLegacyMemoryKey(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() &&
    value.length <= legacyMemoryLimits.keyCharacters && !/\p{Cc}/u.test(value);
}

export function isLegacyMemoryValue(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() &&
    [...value].length <= legacyMemoryLimits.valueCharacters &&
    Buffer.byteLength(value, "utf8") <= legacyMemoryLimits.valueBytes;
}

/** Copy validated source strings so planning never rereads untrusted entry objects. */
export function parseCompleteLegacyMemorySource(value: unknown): LegacyMemoryEntry[] | null {
  try {
    if (!Array.isArray(value) || value.length > legacyMemoryLimits.entries) return null;
    const keys = new Set<string>();
    const entries: LegacyMemoryEntry[] = [];
    let bytes = 0;
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) return null;
      const entry: unknown = value[index];
      if (typeof entry !== "object" || entry === null || Array.isArray(entry) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(entry))) return null;
      const fields = Reflect.ownKeys(entry);
      if (fields.length !== 2 || !fields.includes("key") || !fields.includes("value")) return null;
      const key = Object.getOwnPropertyDescriptor(entry, "key");
      const data = Object.getOwnPropertyDescriptor(entry, "value");
      if (!key || !data || !isLegacyMemoryKey(key.value) || !isLegacyMemoryValue(data.value) ||
        keys.has(key.value)) return null;
      keys.add(key.value);
      bytes += Buffer.byteLength(key.value, "utf8") + Buffer.byteLength(data.value, "utf8");
      if (bytes > legacyMemoryLimits.sourceBytes) return null;
      entries.push({ key: key.value, value: data.value });
    }
    return entries;
  } catch {
    return null;
  }
}

export interface LegacyMemoryReader {
  readNamedScope(scope: string): Promise<readonly LegacyMemoryEntry[]>;
}
