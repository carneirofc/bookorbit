import type { GroupRule } from "./query";

export type TagFacetSort = "count" | "name";

/** Upper bound for `TagFacetsQuery.limit`, so one panel never renders an unbounded tag list. */
export const MAX_TAG_FACETS_LIMIT = 500;

export const DEFAULT_TAG_FACETS_LIMIT = 200;

/** Upper bound for `TagFacetsQuery.onlyTags`, matching the per-rule value cap of book filters. */
export const MAX_TAG_FACETS_ONLY_TAGS = 20;

/**
 * Asks which tags occur among the books matching `filter` and `q`, and on how many of them.
 * `excludeTags` drops tags the caller already narrowed by, since every remaining book carries them.
 * `onlyTags` restricts the answer to the named tags, which is how pairwise overlaps are counted.
 */
export type TagFacetsQuery = {
  filter?: GroupRule;
  q?: string;
  tagSearch?: string;
  excludeTags?: string[];
  onlyTags?: string[];
  sort?: TagFacetSort;
  limit?: number;
};

export type TagFacet = {
  id: number;
  name: string;
  count: number;
};

export type TagFacetsResponse = {
  tags: TagFacet[];
  /** Books matching the query, whether or not they carry any tag. */
  totalBooks: number;
  /** True when more tags matched than `limit` allowed through. */
  truncated: boolean;
};
