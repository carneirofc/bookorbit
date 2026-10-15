import { Injectable, Logger } from '@nestjs/common';

import type { TagFacetsResponse } from '@bookorbit/types';
import { resolveTimeZone } from '../../common/utils/timezone.utils';
import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import { BookQueryBuilder } from './book-query-builder.service';
import { BookRepository } from './book.repository';
import type { ParsedTagFacetsQuery } from './pipes/book-query.pipe';

const SLOW_FACETS_MS = 500;

/**
 * Backs the tag browser: for the books a caller has narrowed to so far, which tags remain and how
 * many books carry each. Uses the same filter tree and access scoping as the global book query, so
 * a tag's count always equals what the book listing returns once that tag is selected.
 */
@Injectable()
export class BookTagFacetsService {
  private readonly logger = new Logger(BookTagFacetsService.name);

  constructor(
    private readonly libraryService: LibraryService,
    private readonly queryBuilder: BookQueryBuilder,
    private readonly bookRepo: BookRepository,
  ) {}

  async getTagFacets(user: RequestUser, query: ParsedTagFacetsQuery): Promise<TagFacetsResponse> {
    const start = Date.now();
    const libraries = await this.libraryService.findAll(user);
    const where = this.queryBuilder.buildWhere(query.filter, {
      accessibleLibraryIds: libraries.map((library) => library.id),
      userId: user.id,
      q: query.q,
      timeZone: resolveTimeZone((user.settings as { timezone?: unknown } | undefined)?.timezone, 'UTC'),
      contentFilters: user.isSuperuser ? undefined : user.contentFilters,
    });

    const [facets, totalBooks] = await Promise.all([
      this.bookRepo.findTagFacets({
        where,
        userId: user.id,
        excludeTags: query.excludeTags,
        onlyTags: query.onlyTags,
        tagSearch: query.tagSearch,
        sort: query.sort,
        limit: query.limit,
      }),
      this.bookRepo.countWhere(where),
    ]);

    const durationMs = Date.now() - start;
    if (durationMs >= SLOW_FACETS_MS) {
      this.logger.warn(
        `[book.tag_facets] [end] userId=${user.id} filterCount=${query.filter?.rules.length ?? 0} excludeCount=${query.excludeTags.length} limit=${query.limit} totalBooks=${totalBooks} tagCount=${facets.tags.length} durationMs=${durationMs} - slow query`,
      );
    }

    return { tags: facets.tags, totalBooks, truncated: facets.truncated };
  }
}
