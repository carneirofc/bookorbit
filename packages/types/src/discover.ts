import type { GroupRule, Rule, StandardRule } from "./query";

/**
 * Discover is a faceted browse over one library. The client keeps a structured selection (which
 * values are included or excluded per facet) instead of a raw filter tree, because facet counts
 * need to know which rules belong to which facet. `compileDiscoverFilter` turns a selection into
 * the ordinary `GroupRule` the book listing, facet counts and smart scopes all understand.
 */
export const DISCOVER_TERM_FACETS = ["tag", "genre", "authorId", "series", "language", "format", "publisher", "readStatus", "rating"] as const;
export type DiscoverTermFacetKey = (typeof DISCOVER_TERM_FACETS)[number];

export const DISCOVER_RANGE_FACETS = ["publishedYear", "pageCount", "addedAt"] as const;
export type DiscoverRangeFacetKey = (typeof DISCOVER_RANGE_FACETS)[number];

export type DiscoverFacetKey = DiscoverTermFacetKey | DiscoverRangeFacetKey;

export type DiscoverMatchMode = "any" | "all";

/** Facets where a book can hold several values at once, so "has all of these" is meaningful. */
export const DISCOVER_MULTI_MATCH_FACETS: readonly DiscoverTermFacetKey[] = ["tag", "genre", "authorId"];

/**
 * Facets with a "(none)" bucket. Format and read status have none: every book counts as unread
 * without a status row, and the format filter has no "no files" operator.
 */
export const DISCOVER_NONE_FACETS: readonly DiscoverTermFacetKey[] = ["tag", "genre", "authorId", "series", "language", "publisher", "rating"];

export const DISCOVER_RATING_VALUES = ["1", "2", "3", "4", "5"] as const;

export const DISCOVER_LIMITS = {
  maxFacets: 12,
  maxValuesPerSide: 100,
  maxSelectedTotal: 200,
  maxFacetLimit: 500,
  defaultFacetLimit: 30,
  maxSearchLength: 200,
  maxValueLength: 200,
  maxWithinLastDays: 36500,
  maxRangeBuckets: 20,
} as const;

/** Values per rule allowed by the filter validator; longer selections are split into chunks. */
const RULE_VALUE_CHUNK = 20;

export interface DiscoverTermSelection {
  /** Raw values. `authorId` and `rating` use decimal strings, `readStatus` a `ReadStatus`. */
  include: string[];
  exclude: string[];
  /** Defaults per facet: `discoverDefaultMode`. `all` is only valid for `DISCOVER_MULTI_MATCH_FACETS`. */
  mode?: DiscoverMatchMode;
  /** Also match books with no value for this facet. */
  includeNone?: boolean;
  /** Drop books with no value for this facet. */
  excludeNone?: boolean;
}

export interface DiscoverRangeSelection {
  /** A number for `publishedYear` and `pageCount`, a `YYYY-MM-DD` UTC date for `addedAt`. */
  min?: number | string;
  max?: number | string;
  /** `addedAt` only: books added in the last N days. Not combined with `min` / `max`. */
  withinLastDays?: number;
}

export interface DiscoverSelection {
  terms?: Partial<Record<DiscoverTermFacetKey, DiscoverTermSelection>>;
  ranges?: Partial<Record<DiscoverRangeFacetKey, DiscoverRangeSelection>>;
}

export type DiscoverFacetSort = "count" | "alpha";

export interface DiscoverFacetRequest {
  key: DiscoverFacetKey;
  /** Term facets only: how many values to return. Default 30, max 500. */
  limit?: number;
  /** Term facets only: accent- and case-insensitive search within the facet's values. */
  search?: string;
  /** Term facets only. Default `count`. */
  sort?: DiscoverFacetSort;
}

export interface DiscoverFacetsRequest {
  selection: DiscoverSelection;
  /** Same quick search as `BookQuery.q`. */
  q?: string;
  /** Up to 12 facets with unique keys; an empty list returns only the totals. */
  facets: DiscoverFacetRequest[];
}

export interface DiscoverFacetValue {
  value: string;
  label: string;
  count: number;
}

export interface DiscoverTermFacetResult {
  kind: "term";
  key: DiscoverTermFacetKey;
  /** Top values by the requested sort, leaving out the ones already included or excluded. */
  values: DiscoverFacetValue[];
  /** Every included and excluded value, in selection order, so chips always have a label. */
  selected: DiscoverFacetValue[];
  /** Books with no value for this facet; always 0 for facets without a "(none)" bucket. */
  noneCount: number;
  truncated: boolean;
}

export interface DiscoverRangeBucket {
  from: number | string;
  to: number | string;
  count: number;
}

export interface DiscoverRangeFacetResult {
  kind: "range";
  key: DiscoverRangeFacetKey;
  /** Numbers for `publishedYear` / `pageCount`, `YYYY-MM-DD` UTC dates for `addedAt`; null when no book has a value. */
  min: number | string | null;
  max: number | string | null;
  /** At most 20 contiguous buckets covering `min`..`max`, both ends inclusive. */
  buckets: DiscoverRangeBucket[];
  noneCount: number;
}

export type DiscoverFacetResult = DiscoverTermFacetResult | DiscoverRangeFacetResult;

export interface DiscoverFacetsResponse {
  /** Books matching the full selection and `q`. */
  total: number;
  /** Books visible in the library with no selection and no `q`. */
  libraryTotal: number;
  facets: Partial<Record<DiscoverFacetKey, DiscoverFacetResult>>;
}

export interface CompileDiscoverFilterOptions {
  /** Leave this facet out of the filter. */
  omitFacet?: DiscoverFacetKey;
  /** With `omitFacet`: drop only that facet's includes (values and `includeNone`), keep its excludes. */
  omitIncludesOnly?: boolean;
}

export function isDiscoverTermFacet(key: string): key is DiscoverTermFacetKey {
  return (DISCOVER_TERM_FACETS as readonly string[]).includes(key);
}

export function isDiscoverRangeFacet(key: string): key is DiscoverRangeFacetKey {
  return (DISCOVER_RANGE_FACETS as readonly string[]).includes(key);
}

/** Tags drill down (ALL), every other facet widens (ANY). */
export function discoverDefaultMode(key: DiscoverTermFacetKey): DiscoverMatchMode {
  return key === "tag" ? "all" : "any";
}

export function discoverTermMode(key: DiscoverTermFacetKey, selection: DiscoverTermSelection | undefined): DiscoverMatchMode {
  if (!DISCOVER_MULTI_MATCH_FACETS.includes(key)) return "any";
  return selection?.mode ?? discoverDefaultMode(key);
}

export function hasDiscoverTermIncludes(selection: DiscoverTermSelection | undefined): boolean {
  return Boolean(selection && (selection.include.length > 0 || selection.includeNone));
}

export function hasDiscoverTermSelection(selection: DiscoverTermSelection | undefined): boolean {
  return Boolean(selection && (hasDiscoverTermIncludes(selection) || selection.exclude.length > 0 || selection.excludeNone));
}

export function hasDiscoverRangeSelection(selection: DiscoverRangeSelection | undefined): boolean {
  return Boolean(selection && (selection.min !== undefined || selection.max !== undefined || selection.withinLastDays !== undefined));
}

export function hasDiscoverSelection(selection: DiscoverSelection): boolean {
  const terms = Object.values(selection.terms ?? {}).some((term) => hasDiscoverTermSelection(term));
  const ranges = Object.values(selection.ranges ?? {}).some((range) => hasDiscoverRangeSelection(range));
  return terms || ranges;
}

type RuleNode = Rule | GroupRule;

function rule(field: StandardRule["field"], operator: Rule["operator"], value?: Rule["value"], valueTo?: Rule["valueTo"]): StandardRule {
  return {
    type: "rule",
    field,
    operator,
    ...(value !== undefined ? { value } : {}),
    ...(valueTo !== undefined ? { valueTo } : {}),
  };
}

function join(kind: GroupRule["join"], nodes: RuleNode[]): RuleNode | undefined {
  if (nodes.length === 0) return undefined;
  if (nodes.length === 1) return nodes[0];
  return { type: "group", join: kind, rules: nodes };
}

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += RULE_VALUE_CHUNK) result.push(values.slice(index, index + RULE_VALUE_CHUNK));
  return result;
}

function toRuleValues(key: DiscoverTermFacetKey, values: string[]): string[] | number[] {
  return key === "authorId" ? values.map(Number) : values;
}

function ratingTermGroup(selection: DiscoverTermSelection, keepIncludes: boolean): RuleNode | undefined {
  const parts: RuleNode[] = [];
  if (keepIncludes) {
    const includes = selection.include.map((value) => rule("rating", "eq", Number(value)));
    if (selection.includeNone) includes.push(rule("rating", "isEmpty"));
    const includeClause = join("OR", includes);
    if (includeClause) parts.push(includeClause);
  }
  if (selection.exclude.length > 0) {
    // `rating` has no "not equal" operator that keeps unrated books, so an exclusion is written as
    // the complement: unrated, or any rating the user did not exclude.
    const kept = DISCOVER_RATING_VALUES.filter((value) => !selection.exclude.includes(value));
    const complement = join("OR", [rule("rating", "isEmpty"), ...kept.map((value) => rule("rating", "eq", Number(value)))]);
    if (complement) parts.push(complement);
  }
  if (selection.excludeNone) parts.push(rule("rating", "isNotEmpty"));
  return join("AND", parts);
}

function termGroup(key: DiscoverTermFacetKey, selection: DiscoverTermSelection, keepIncludes: boolean): RuleNode | undefined {
  if (key === "rating") return ratingTermGroup(selection, keepIncludes);

  const field: StandardRule["field"] = key;
  const supportsNone = DISCOVER_NONE_FACETS.includes(key);
  const parts: RuleNode[] = [];

  if (keepIncludes) {
    const valueChunks = chunks(selection.include);
    const includeNone = supportsNone && selection.includeNone ? [rule(field, "isEmpty")] : [];
    if (discoverTermMode(key, selection) === "all") {
      const allOf = join(
        "AND",
        valueChunks.map((values) => rule(field, "includesAll", toRuleValues(key, values))),
      );
      const includeClause = join("OR", [...(allOf ? [allOf] : []), ...includeNone]);
      if (includeClause) parts.push(includeClause);
    } else {
      const includeClause = join("OR", [...valueChunks.map((values) => rule(field, "includesAny", toRuleValues(key, values))), ...includeNone]);
      if (includeClause) parts.push(includeClause);
    }
  }

  for (const values of chunks(selection.exclude)) parts.push(rule(field, "excludesAll", toRuleValues(key, values)));
  if (supportsNone && selection.excludeNone) parts.push(rule(field, "isNotEmpty"));
  return join("AND", parts);
}

function addDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function rangeGroup(key: DiscoverRangeFacetKey, selection: DiscoverRangeSelection): RuleNode | undefined {
  if (key === "addedAt") {
    if (selection.withinLastDays !== undefined) return rule("addedAt", "withinLast", selection.withinLastDays);
    const min = typeof selection.min === "string" ? selection.min : undefined;
    const max = typeof selection.max === "string" ? selection.max : undefined;
    // Whole UTC days, both ends inclusive: `between` compares instants, `after` / `before` are strict.
    if (min && max) return rule("addedAt", "between", `${min}T00:00:00.000Z`, `${max}T23:59:59.999Z`);
    if (min) return rule("addedAt", "after", `${addDays(min, -1)}T23:59:59.999Z`);
    if (max) return rule("addedAt", "before", `${addDays(max, 1)}T00:00:00.000Z`);
    return undefined;
  }
  const min = typeof selection.min === "number" ? selection.min : undefined;
  const max = typeof selection.max === "number" ? selection.max : undefined;
  if (min !== undefined && max !== undefined) return rule(key, "between", min, max);
  if (min !== undefined) return rule(key, "gte", min);
  if (max !== undefined) return rule(key, "lte", max);
  return undefined;
}

/**
 * Compiles a Discover selection into a filter tree: an AND of one node per active facet. Within a
 * term facet, ANY includes are ORed (`includesAny` chunks plus `isEmpty` for `includeNone`), ALL
 * includes are ANDed `includesAll` chunks (ORed with `isEmpty` when `includeNone` is set), and
 * excludes are ANDed `excludesAll` chunks plus `isNotEmpty` for `excludeNone`. The tree is at
 * most four groups deep, within the validator's limit of five, and every rule passes it.
 *
 * Returns undefined when nothing is selected, which the listing reads as "no filter".
 */
export function compileDiscoverFilter(selection: DiscoverSelection, options: CompileDiscoverFilterOptions = {}): GroupRule | undefined {
  const nodes: RuleNode[] = [];
  for (const key of DISCOVER_TERM_FACETS) {
    const term = selection.terms?.[key];
    if (!term) continue;
    const omitted = options.omitFacet === key;
    if (omitted && !options.omitIncludesOnly) continue;
    const node = termGroup(key, term, !omitted);
    if (node) nodes.push(node);
  }
  for (const key of DISCOVER_RANGE_FACETS) {
    const range = selection.ranges?.[key];
    if (!range || options.omitFacet === key) continue;
    const node = rangeGroup(key, range);
    if (node) nodes.push(node);
  }
  if (nodes.length === 0) return undefined;
  return { type: "group", join: "AND", rules: nodes };
}
