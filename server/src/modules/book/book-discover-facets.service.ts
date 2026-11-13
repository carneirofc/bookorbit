import { ForbiddenException, HttpException, Injectable, Logger } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';

import {
  BOOK_FILTER_FORMATS,
  DISCOVER_LIMITS,
  DISCOVER_NONE_FACETS,
  DISCOVER_RATING_VALUES,
  READ_STATUSES,
  compileDiscoverFilter,
  discoverTermMode,
  hasDiscoverRangeSelection,
  hasDiscoverSelection,
  hasDiscoverTermIncludes,
  isDiscoverRangeFacet,
  type DiscoverFacetRequest,
  type DiscoverFacetResult,
  type DiscoverFacetValue,
  type DiscoverFacetsRequest,
  type DiscoverFacetsResponse,
  type DiscoverRangeFacetKey,
  type DiscoverRangeFacetResult,
  type DiscoverSelection,
  type DiscoverTermFacetKey,
  type DiscoverTermFacetResult,
  type GroupRule,
} from '@bookorbit/types';
import { mapWithConcurrency } from '../../common/utils/batch.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { resolveTimeZone } from '../../common/utils/timezone.utils';
import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import { BookDiscoverFacetsRepository, type DiscoverRelation, type DiscoverValueCount } from './book-discover-facets.repository';
import { BookQueryBuilder } from './book-query-builder.service';
import { BookRepository } from './book.repository';
import { validateGroupRule } from './utils/group-rule.validator';

const SLOW_DISCOVER_FACETS_MS = 300;
const FACET_CONCURRENCY = 3;

const RELATION_BY_FACET: Partial<Record<DiscoverTermFacetKey, DiscoverRelation>> = {
  tag: 'tag',
  genre: 'genre',
  authorId: 'author',
  series: 'series',
};

type ScopeContext = {
  accessibleLibraryIds: number[];
  q: string | undefined;
  implicitLibraryId: number;
  userId: number;
  timeZone: string;
  contentFilters: RequestUser['contentFilters'] | undefined;
};

/** The filter one facet's counts are read under, and the `where` it compiles to. */
type EffectiveFilter = { filter: GroupRule | undefined; where: SQL | undefined };

type TermListOptions = { search?: string; sort: 'count' | 'alpha'; limit: number; excludeValues: string[] };

type FacetCounts = {
  listed: { values: DiscoverValueCount[]; truncated: boolean };
  /** Counts for at least the selected values; the ones missing count 0. */
  selectedCounts: DiscoverValueCount[];
  noneCount: number;
};

const FIXED_VALUE_FACETS = new Set<DiscoverTermFacetKey>(['format', 'readStatus', 'rating']);

function withRule(filter: GroupRule | undefined, rule: GroupRule['rules'][number]): GroupRule {
  return filter ? { type: 'group', join: 'AND', rules: [...filter.rules, rule] } : { type: 'group', join: 'AND', rules: [rule] };
}

function countSelected(selection: DiscoverSelection): number {
  let count = 0;
  for (const term of Object.values(selection.terms ?? {})) {
    count += term.include.length + term.exclude.length + (term.includeNone ? 1 : 0) + (term.excludeNone ? 1 : 0);
  }
  for (const range of Object.values(selection.ranges ?? {})) {
    if (hasDiscoverRangeSelection(range)) count += 1;
  }
  return count;
}

function bySort(sort: 'count' | 'alpha') {
  return (a: DiscoverValueCount, b: DiscoverValueCount) =>
    sort === 'alpha' ? a.label.localeCompare(b.label) : b.count - a.count || a.label.localeCompare(b.label);
}

function monthStart(monthIndex: number): string {
  return new Date(Date.UTC(Math.floor(monthIndex / 12), monthIndex % 12, 1)).toISOString().slice(0, 10);
}

function monthEnd(monthIndex: number): string {
  return new Date(Date.UTC(Math.floor(monthIndex / 12), (monthIndex % 12) + 1, 0)).toISOString().slice(0, 10);
}

/**
 * Backs the Discover view: per-facet value counts for one library, computed under the standard
 * faceted-search rule. An ANY facet with includes is counted without its own includes, so each
 * value shows how many books it would add; an ALL facet (drill-down) and a facet with nothing
 * included are counted under the full selection; a range facet is summarized without its own
 * range. Excludes always apply. Facets that share an effective filter share its compiled `where`.
 */
@Injectable()
export class BookDiscoverFacetsService {
  private readonly logger = new Logger(BookDiscoverFacetsService.name);

  constructor(
    private readonly libraryService: LibraryService,
    private readonly queryBuilder: BookQueryBuilder,
    private readonly bookRepo: BookRepository,
    private readonly facetsRepo: BookDiscoverFacetsRepository,
  ) {}

  async facetsForLibrary(user: RequestUser, libraryId: number, request: DiscoverFacetsRequest): Promise<DiscoverFacetsResponse> {
    const start = Date.now();
    try {
      const accessibleLibraryIds = await this.libraryService.resolveBookScope(user, libraryId);
      if (accessibleLibraryIds.length === 0) throw new ForbiddenException('No access to this library');
      const scope: ScopeContext = {
        accessibleLibraryIds,
        q: request.q,
        implicitLibraryId: libraryId,
        userId: user.id,
        timeZone: resolveTimeZone((user.settings as { timezone?: unknown } | undefined)?.timezone, 'UTC'),
        contentFilters: user.isSuperuser ? undefined : user.contentFilters,
      };

      const libraryWhere = this.queryBuilder.buildWhere(undefined, { ...scope, q: undefined });
      const filters = new Map<string, EffectiveFilter>();
      const effective = (key: string, compile: () => GroupRule | undefined): EffectiveFilter => {
        let entry = filters.get(key);
        if (!entry) {
          const filter = compile();
          if (filter) validateGroupRule(filter);
          entry = { filter, where: this.queryBuilder.buildWhere(filter, scope) };
          filters.set(key, entry);
        }
        return entry;
      };
      const full = effective('full', () => compileDiscoverFilter(request.selection));

      const hasQuery = Boolean(request.q?.trim());
      const narrowed = hasDiscoverSelection(request.selection) || hasQuery;
      const facetFilters = request.facets.map((facet) => this.effectiveFilterFor(facet, request.selection, full, effective));

      const [totals, results] = await Promise.all([
        Promise.all([this.bookRepo.countWhere(full.where), narrowed ? this.bookRepo.countWhere(libraryWhere) : null]),
        mapWithConcurrency(request.facets, FACET_CONCURRENCY, (facet, index) =>
          this.computeFacet(facet, request.selection, facetFilters[index]!, scope, libraryWhere),
        ),
      ]);
      const [total, libraryTotal] = totals;

      const facets: DiscoverFacetsResponse['facets'] = {};
      request.facets.forEach((facet, index) => {
        facets[facet.key] = results[index];
      });

      const durationMs = Date.now() - start;
      if (durationMs >= SLOW_DISCOVER_FACETS_MS) {
        this.logger.warn(
          `[book.discover_facets] [end] userId=${user.id} libraryId=${libraryId} facetCount=${request.facets.length} selectedCount=${countSelected(request.selection)} hasQuery=${hasQuery} filterGroups=${filters.size} total=${total} durationMs=${durationMs} - slow query`,
        );
      }
      return { total, libraryTotal: libraryTotal ?? total, facets };
    } catch (error) {
      if (!(error instanceof HttpException)) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error(
          `[book.discover_facets] [fail] userId=${user.id} libraryId=${libraryId} facetCount=${request.facets.length} durationMs=${Date.now() - start} errorClass=${err.constructor.name} error="${sanitizeLogValue(err.message)}" - discover facets failed`,
        );
      }
      throw error;
    }
  }

  private effectiveFilterFor(
    facet: DiscoverFacetRequest,
    selection: DiscoverSelection,
    full: EffectiveFilter,
    effective: (key: string, compile: () => GroupRule | undefined) => EffectiveFilter,
  ): EffectiveFilter {
    const key = facet.key;
    if (isDiscoverRangeFacet(key)) {
      if (!hasDiscoverRangeSelection(selection.ranges?.[key])) return full;
      return effective(`omit:${key}`, () => compileDiscoverFilter(selection, { omitFacet: key }));
    }
    const term = selection.terms?.[key];
    if (discoverTermMode(key, term) === 'all' || !hasDiscoverTermIncludes(term)) return full;
    return effective(`omit-includes:${key}`, () => compileDiscoverFilter(selection, { omitFacet: key, omitIncludesOnly: true }));
  }

  private computeFacet(
    facet: DiscoverFacetRequest,
    selection: DiscoverSelection,
    filter: EffectiveFilter,
    scope: ScopeContext,
    libraryWhere: SQL | undefined,
  ): Promise<DiscoverFacetResult> {
    if (isDiscoverRangeFacet(facet.key)) return this.computeRangeFacet(facet.key, filter);
    return this.computeTermFacet(facet as DiscoverFacetRequest & { key: DiscoverTermFacetKey }, selection, filter, scope, libraryWhere);
  }

  private async computeTermFacet(
    facet: DiscoverFacetRequest & { key: DiscoverTermFacetKey },
    selection: DiscoverSelection,
    filter: EffectiveFilter,
    scope: ScopeContext,
    libraryWhere: SQL | undefined,
  ): Promise<DiscoverTermFacetResult> {
    const key = facet.key;
    const term = selection.terms?.[key];
    const selectedValues = [...(term?.include ?? []), ...(term?.exclude ?? [])];
    const options: TermListOptions = {
      search: facet.search,
      sort: facet.sort ?? 'count',
      limit: facet.limit ?? DISCOVER_LIMITS.defaultFacetLimit,
      excludeValues: selectedValues,
    };

    const { listed, selectedCounts, noneCount } = FIXED_VALUE_FACETS.has(key)
      ? await this.countFixedFacet(key, filter.where, options, scope.userId)
      : await this.countOpenFacet(key, filter, options, scope, libraryWhere);

    const countsByValue = new Map(selectedCounts.map((row) => [row.value, row]));
    const selected: DiscoverFacetValue[] = selectedValues.map((value) => {
      const row = countsByValue.get(value);
      return { value, label: row?.label ?? value, count: row?.count ?? 0 };
    });
    return { kind: 'term', key, values: listed.values, selected, noneCount, truncated: listed.truncated };
  }

  /** Relation and metadata facets: open-ended value sets, listed and counted in the database. */
  private async countOpenFacet(
    key: DiscoverTermFacetKey,
    filter: EffectiveFilter,
    options: TermListOptions,
    scope: ScopeContext,
    libraryWhere: SQL | undefined,
  ): Promise<FacetCounts> {
    const relation = RELATION_BY_FACET[key];
    const column = key === 'language' || key === 'publisher' ? key : undefined;
    const where = filter.where;
    const values = options.excludeValues;
    const [listed, selectedCounts, noneCount] = await Promise.all([
      relation
        ? this.facetsRepo.findRelationValues({ relation, where, ...options })
        : this.facetsRepo.findMetadataValues({ column: column!, where, ...options }),
      relation
        ? this.facetsRepo.countRelationValues({ relation, where, scopeWhere: libraryWhere, values })
        : this.facetsRepo.countMetadataValues({ column: column!, where, values }),
      this.countNone(key, filter.filter, scope),
    ]);
    return { listed, selectedCounts, noneCount };
  }

  /** Format, read status and rating have a small fixed value set, counted in one pass and listed here. */
  private async countFixedFacet(key: DiscoverTermFacetKey, where: SQL | undefined, options: TermListOptions, userId: number): Promise<FacetCounts> {
    const { values, noneCount } = await this.countFixedValues(key, where, userId);
    const search = options.search?.trim().toLowerCase();
    const listed = values
      .filter((row) => row.count > 0 && !options.excludeValues.includes(row.value) && (!search || row.label.toLowerCase().includes(search)))
      .sort(bySort(options.sort));
    return {
      listed: { values: listed.slice(0, options.limit), truncated: listed.length > options.limit },
      selectedCounts: values,
      noneCount,
    };
  }

  private async countFixedValues(
    key: DiscoverTermFacetKey,
    where: SQL | undefined,
    userId: number,
  ): Promise<{ values: DiscoverValueCount[]; noneCount: number }> {
    if (key === 'format') {
      const rows = await this.bookRepo.countFormatFacets(where, BOOK_FILTER_FORMATS);
      return { values: rows.map((row) => ({ value: row.format, label: row.format, count: row.count })), noneCount: 0 };
    }
    if (key === 'readStatus') {
      const rows = await this.facetsRepo.countReadStatuses(where, userId);
      const known = new Set<string>(READ_STATUSES);
      return { values: rows.filter((row) => known.has(row.value)).map((row) => ({ ...row, label: row.value })), noneCount: 0 };
    }
    const rows = await this.facetsRepo.countUserRatings(where, userId);
    const values = DISCOVER_RATING_VALUES.map((value) => ({
      value,
      label: value,
      count: rows.find((row) => row.rating === Number(value))?.count ?? 0,
    }));
    return { values, noneCount: rows.find((row) => row.rating === null)?.count ?? 0 };
  }

  /** Books in the facet's effective set with no value for it: what the listing adds once "(none)" is picked. */
  private async countNone(key: DiscoverTermFacetKey, filter: GroupRule | undefined, scope: ScopeContext): Promise<number> {
    if (!DISCOVER_NONE_FACETS.includes(key)) return 0;
    const noneFilter = withRule(filter, { type: 'rule', field: key, operator: 'isEmpty' });
    return this.bookRepo.countWhere(this.queryBuilder.buildWhere(noneFilter, scope));
  }

  private async computeRangeFacet(key: DiscoverRangeFacetKey, filter: EffectiveFilter): Promise<DiscoverRangeFacetResult> {
    const summary = await this.facetsRepo.findRangeSummary(key, filter.where);
    if (summary.min === null || summary.max === null) {
      return { kind: 'range', key, min: null, max: null, buckets: [], noneCount: summary.noneCount };
    }
    const { min, max } = summary;
    const width = Math.max(1, Math.ceil((max - min + 1) / DISCOVER_LIMITS.maxRangeBuckets));
    const counts = await this.facetsRepo.countRangeBuckets(key, filter.where, min, width);
    const countByBucket = new Map(counts.map((row) => [row.bucket, row.count]));
    const bucketCount = Math.ceil((max - min + 1) / width);
    const buckets = Array.from({ length: bucketCount }, (_, index) => {
      const from = min + index * width;
      const to = Math.min(from + width - 1, max);
      const count = countByBucket.get(index) ?? 0;
      return key === 'addedAt' ? { from: monthStart(from), to: monthEnd(to), count } : { from, to, count };
    });
    if (key !== 'addedAt') return { kind: 'range', key, min, max, buckets, noneCount: summary.noneCount };
    return { kind: 'range', key, min: monthStart(min), max: monthEnd(max), buckets, noneCount: summary.noneCount };
  }
}
