// Internal RFC 8785 serializer. Manifest validation supplies plain JSON data.
type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

export function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

export function canonicalizeJcsJson(value: Json): string {
  if (typeof value === "string" && hasLoneSurrogate(value))
    throw new TypeError("lone Unicode surrogate");
  if (typeof value === "number" && !Number.isFinite(value))
    throw new TypeError("non-finite JSON number");
  if (Array.isArray(value))
    return `[${value.map(canonicalizeJcsJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        if (hasLoneSurrogate(key))
          throw new TypeError("lone Unicode surrogate in key");
        return `${JSON.stringify(key)}:${canonicalizeJcsJson((value as Record<string, Json>)[key]!)}`;
      })
      .join(",")}}`;
  return JSON.stringify(value);
}
