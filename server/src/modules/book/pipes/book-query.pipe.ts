import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { z } from 'zod';

import {
  DEFAULT_TAG_FACETS_LIMIT,
  MAX_RANDOM_SORT_SEED,
  MAX_TAG_FACETS_LIMIT,
  MAX_TAG_FACETS_ONLY_TAGS,
  isSortField,
  type BookQuery,
  type JumpBucketsQuery,
  type SortField,
  type TagFacetsQuery,
} from '@bookorbit/types';

import { MAX_BOOK_QUERY_OFFSET_ROWS, isBookQueryOffsetWithinLimit } from '../../../common/constants/pagination.constants';
import { groupRuleSchema } from '../utils/group-rule.validator';

const sortFieldSchema = z.custom<SortField>((value) => typeof value === 'string' && isSortField(value), { message: 'Unsupported sort field' });

const bookQuerySchema = z.object({
  collapseSeries: z.boolean().optional(),
  filter: groupRuleSchema(5).optional(),
  q: z.string().max(200).optional(),
  randomSeed: z.number().int().min(0).max(MAX_RANDOM_SORT_SEED).optional(),
  sort: z
    .array(
      z.object({
        field: sortFieldSchema,
        dir: z.enum(['asc', 'desc']),
      }),
    )
    .max(5)
    .default([]),
  pagination: z
    .object({
      page: z.number().int().min(0).default(0),
      size: z.number().int().min(1).max(200).default(50),
    })
    .superRefine((pagination, ctx) => {
      if (!isBookQueryOffsetWithinLimit(pagination.page * pagination.size)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `pagination window is too deep; page * size must be <= ${MAX_BOOK_QUERY_OFFSET_ROWS}`,
          path: ['page'],
        });
      }
    })
    .default({ page: 0, size: 50 }),
});

const jumpBucketsQuerySchema = bookQuerySchema.extend({
  maxBuckets: z.number().int().min(8).max(64).default(32),
});

const tagFacetsQuerySchema = z.object({
  filter: groupRuleSchema(5).optional(),
  q: z.string().max(200).optional(),
  tagSearch: z.string().max(200).optional(),
  excludeTags: z.array(z.string().min(1).max(200)).max(100).default([]),
  onlyTags: z.array(z.string().min(1).max(200)).min(1).max(MAX_TAG_FACETS_ONLY_TAGS).optional(),
  sort: z.enum(['count', 'name']).default('count'),
  limit: z.number().int().min(1).max(MAX_TAG_FACETS_LIMIT).default(DEFAULT_TAG_FACETS_LIMIT),
});

export type ParsedTagFacetsQuery = TagFacetsQuery & Required<Pick<TagFacetsQuery, 'excludeTags' | 'sort' | 'limit'>>;

@Injectable()
export class BookQueryPipe implements PipeTransform {
  transform(value: unknown): BookQuery {
    const result = bookQuerySchema.safeParse(value ?? {});
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return result.data as BookQuery;
  }
}

@Injectable()
export class JumpBucketsQueryPipe implements PipeTransform {
  transform(value: unknown): JumpBucketsQuery {
    const result = jumpBucketsQuerySchema.safeParse(value ?? {});
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return result.data as JumpBucketsQuery;
  }
}

@Injectable()
export class TagFacetsQueryPipe implements PipeTransform {
  transform(value: unknown): ParsedTagFacetsQuery {
    const result = tagFacetsQuerySchema.safeParse(value ?? {});
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return result.data as ParsedTagFacetsQuery;
  }
}
