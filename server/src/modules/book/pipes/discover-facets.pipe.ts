import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { z } from 'zod';

import {
  BOOK_FILTER_FORMATS,
  DISCOVER_LIMITS,
  DISCOVER_MULTI_MATCH_FACETS,
  DISCOVER_NONE_FACETS,
  DISCOVER_RANGE_FACETS,
  DISCOVER_RATING_VALUES,
  DISCOVER_TERM_FACETS,
  READ_STATUSES,
  isDiscoverRangeFacet,
  type DiscoverFacetsRequest,
  type DiscoverTermFacetKey,
} from '@bookorbit/types';
import { isDateKey } from '../../../common/utils/timezone.utils';

const MAX_INT4 = 2_147_483_647;
const AUTHOR_ID_RE = /^[1-9]\d{0,9}$/;

const valueListSchema = z.array(z.string().min(1).max(DISCOVER_LIMITS.maxValueLength)).max(DISCOVER_LIMITS.maxValuesPerSide).default([]);

const termSelectionSchema = z.strictObject({
  include: valueListSchema,
  exclude: valueListSchema,
  mode: z.enum(['any', 'all']).optional(),
  includeNone: z.boolean().optional(),
  excludeNone: z.boolean().optional(),
});

const numericRangeSchema = (min: number, max: number) =>
  z.strictObject({
    min: z.number().int().min(min).max(max).optional(),
    max: z.number().int().min(min).max(max).optional(),
  });

const dateKeySchema = z.string().refine(isDateKey, { message: 'Expected a YYYY-MM-DD date' });

const selectionSchema = z.strictObject({
  terms: z
    .strictObject(
      Object.fromEntries(DISCOVER_TERM_FACETS.map((key) => [key, termSelectionSchema.optional()])) as Record<
        DiscoverTermFacetKey,
        z.ZodOptional<typeof termSelectionSchema>
      >,
    )
    .optional(),
  ranges: z
    .strictObject({
      publishedYear: numericRangeSchema(-9999, 9999).optional(),
      pageCount: numericRangeSchema(0, 1_000_000).optional(),
      addedAt: z
        .strictObject({
          min: dateKeySchema.optional(),
          max: dateKeySchema.optional(),
          withinLastDays: z.number().int().min(1).max(DISCOVER_LIMITS.maxWithinLastDays).optional(),
        })
        .optional(),
    })
    .optional(),
});

const facetRequestSchema = z.strictObject({
  key: z.enum([...DISCOVER_TERM_FACETS, ...DISCOVER_RANGE_FACETS]),
  limit: z.number().int().min(1).max(DISCOVER_LIMITS.maxFacetLimit).optional(),
  search: z.string().max(DISCOVER_LIMITS.maxSearchLength).optional(),
  sort: z.enum(['count', 'alpha']).optional(),
});

const ALLOWED_TERM_VALUES: Partial<Record<DiscoverTermFacetKey, readonly string[]>> = {
  format: BOOK_FILTER_FORMATS,
  readStatus: READ_STATUSES,
  rating: DISCOVER_RATING_VALUES,
};

function checkTermValues(key: DiscoverTermFacetKey, values: string[], path: (string | number)[], ctx: z.RefinementCtx): void {
  const allowed = ALLOWED_TERM_VALUES[key];
  values.forEach((value, index) => {
    if (allowed && !allowed.includes(value)) {
      ctx.addIssue({ code: 'custom', message: `Unknown ${key} value`, path: [...path, index] });
    }
    if (key === 'authorId' && (!AUTHOR_ID_RE.test(value) || Number(value) > MAX_INT4)) {
      ctx.addIssue({ code: 'custom', message: 'authorId values are author ids', path: [...path, index] });
    }
  });
  if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: 'Duplicate values', path });
}

const discoverFacetsRequestSchema = z
  .strictObject({
    selection: selectionSchema.default({}),
    q: z.string().max(200).optional(),
    facets: z.array(facetRequestSchema).max(DISCOVER_LIMITS.maxFacets).default([]),
  })
  .superRefine((request, ctx) => {
    let selectedTotal = 0;
    for (const key of DISCOVER_TERM_FACETS) {
      const term = request.selection.terms?.[key];
      if (!term) continue;
      const path = ['selection', 'terms', key];
      selectedTotal += term.include.length + term.exclude.length;
      checkTermValues(key, term.include, [...path, 'include'], ctx);
      checkTermValues(key, term.exclude, [...path, 'exclude'], ctx);
      if (term.include.some((value) => term.exclude.includes(value))) {
        ctx.addIssue({ code: 'custom', message: 'A value cannot be both included and excluded', path });
      }
      if (term.mode === 'all' && !DISCOVER_MULTI_MATCH_FACETS.includes(key)) {
        ctx.addIssue({ code: 'custom', message: `Match mode 'all' is not available for ${key}`, path: [...path, 'mode'] });
      }
      if ((term.includeNone || term.excludeNone) && !DISCOVER_NONE_FACETS.includes(key)) {
        ctx.addIssue({ code: 'custom', message: `${key} has no "none" bucket`, path });
      }
      if (term.includeNone && term.excludeNone) {
        ctx.addIssue({ code: 'custom', message: 'includeNone and excludeNone cannot both be set', path });
      }
    }
    if (selectedTotal > DISCOVER_LIMITS.maxSelectedTotal) {
      ctx.addIssue({ code: 'custom', message: `At most ${DISCOVER_LIMITS.maxSelectedTotal} values can be selected`, path: ['selection'] });
    }

    for (const key of DISCOVER_RANGE_FACETS) {
      const range = request.selection.ranges?.[key];
      if (!range) continue;
      const path = ['selection', 'ranges', key];
      if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
        ctx.addIssue({ code: 'custom', message: 'min must not exceed max', path });
      }
      if ('withinLastDays' in range && range.withinLastDays !== undefined && (range.min !== undefined || range.max !== undefined)) {
        ctx.addIssue({ code: 'custom', message: 'withinLastDays cannot be combined with min or max', path });
      }
    }

    const seen = new Set<string>();
    request.facets.forEach((facet, index) => {
      if (seen.has(facet.key)) ctx.addIssue({ code: 'custom', message: 'Duplicate facet key', path: ['facets', index, 'key'] });
      seen.add(facet.key);
      if (isDiscoverRangeFacet(facet.key) && (facet.limit !== undefined || facet.search !== undefined || facet.sort !== undefined)) {
        ctx.addIssue({ code: 'custom', message: 'limit, search and sort only apply to term facets', path: ['facets', index] });
      }
    });
  });

@Injectable()
export class DiscoverFacetsRequestPipe implements PipeTransform {
  transform(value: unknown): DiscoverFacetsRequest {
    const result = discoverFacetsRequestSchema.safeParse(value ?? {});
    if (!result.success) {
      const issue = result.error.issues[0]!;
      const path = issue.path.length > 0 ? issue.path.join('.') : 'body';
      throw new BadRequestException({ message: `Invalid discover facets request: ${path}: ${issue.message}`, errors: result.error.flatten() });
    }
    return result.data as DiscoverFacetsRequest;
  }
}
