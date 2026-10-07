import type { KnowledgeContribution } from "../../../domain-pack-contracts/src/index.ts";

/**
 * The typed guidance of one pack knowledge entry (GP-15): plain JSON data,
 * every member present only when the pack declares it, compared in canonical
 * form. It is a declaration. Nothing reads, seeds or searches a store from it,
 * and a seed is an opaque string that is never resolved.
 */
export type KnowledgeGuidance = {
  readonly category?: string;
  readonly schema?: readonly {
    readonly field: string;
    readonly description: string;
  }[];
  readonly seeds?: readonly string[];
  readonly retrieval?: {
    readonly maxResults?: number;
    readonly hint?: string;
    readonly categories?: readonly string[];
  };
};

/** The typed members of a knowledge entry, in the manifest's validated order. */
export function knowledgeGuidance(
  entry: KnowledgeContribution,
): KnowledgeGuidance {
  const { category, schema, seeds, retrieval } = entry;
  return {
    ...(category === undefined ? {} : { category }),
    ...(schema === undefined
      ? {}
      : {
          schema: schema.map(({ field, description }) => ({
            field,
            description,
          })),
        }),
    ...(seeds === undefined ? {} : { seeds: [...seeds] }),
    ...(retrieval === undefined
      ? {}
      : {
          retrieval: {
            ...(retrieval.maxResults === undefined
              ? {}
              : { maxResults: retrieval.maxResults }),
            ...(retrieval.hint === undefined ? {} : { hint: retrieval.hint }),
            ...(retrieval.categories === undefined
              ? {}
              : { categories: [...retrieval.categories] }),
          },
        }),
  };
}

/** Whether an entry declares any typed member. */
export function hasKnowledgeGuidance(guidance: KnowledgeGuidance): boolean {
  return Object.keys(guidance).length > 0;
}
