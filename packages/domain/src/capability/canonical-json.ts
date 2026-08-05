import { CanonicalSerializationError } from "./errors.ts";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

const forbiddenObjectKeys = new Set(["__proto__", "constructor", "prototype"]);

function normalize(
  value: unknown,
  path: string,
  ancestors: ReadonlySet<object>,
): CanonicalJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new CanonicalSerializationError(
        path,
        "non-finite numbers are forbidden",
      );
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === undefined)
    throw new CanonicalSerializationError(path, "undefined is forbidden");
  if (
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  )
    throw new CanonicalSerializationError(
      path,
      `${typeof value} values are forbidden`,
    );
  if (typeof value !== "object")
    throw new CanonicalSerializationError(
      path,
      "value is not JSON serializable",
    );
  if (ancestors.has(value))
    throw new CanonicalSerializationError(
      path,
      "cyclic references are forbidden",
    );

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0)
      throw new CanonicalSerializationError(
        path,
        "symbol array properties are forbidden",
      );
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === "length") continue;
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)
        throw new CanonicalSerializationError(
          `${path}.${key}`,
          "additional array properties are forbidden",
        );
    }
    const normalized: CanonicalJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value))
        throw new CanonicalSerializationError(
          `${path}[${index}]`,
          "sparse arrays are forbidden",
        );
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      )
        throw new CanonicalSerializationError(
          `${path}[${index}]`,
          "array accessors are forbidden",
        );
      normalized.push(
        normalize(descriptor.value, `${path}[${index}]`, nextAncestors),
      );
    }
    return Object.freeze(normalized);
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null)
    throw new CanonicalSerializationError(
      path,
      "only plain objects are supported",
    );
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new CanonicalSerializationError(path, "symbol keys are forbidden");
  const record = value as Record<string, unknown>;
  const normalized = Object.create(null) as Record<string, CanonicalJsonValue>;
  for (const key of Object.getOwnPropertyNames(record).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    )
      throw new CanonicalSerializationError(
        `${path}.${key}`,
        "accessor and non-enumerable properties are forbidden",
      );
    if (forbiddenObjectKeys.has(key))
      throw new CanonicalSerializationError(
        `${path}.${key}`,
        "prototype-sensitive keys are forbidden",
      );
    normalized[key] = normalize(
      descriptor.value,
      `${path}.${key}`,
      nextAncestors,
    );
  }
  return Object.freeze(normalized);
}

export function normalizeCanonicalJson(value: unknown): CanonicalJsonValue {
  return normalize(value, "$", new Set());
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(normalizeCanonicalJson(value));
}
