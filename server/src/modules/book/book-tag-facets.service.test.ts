import { sql } from 'drizzle-orm';

import type { GroupRule } from '@bookorbit/types';
import { BookTagFacetsService } from './book-tag-facets.service';
import type { ParsedTagFacetsQuery } from './pipes/book-query.pipe';

const contentFilters = { includeTagIds: [], excludeTagIds: [5], includeGenreIds: [], excludeGenreIds: [] };

function reqUser(overrides: Record<string, unknown> = {}) {
  return { id: 7, isSuperuser: false, permissions: [], contentFilters, settings: { timezone: 'Europe/Lisbon' }, ...overrides } as never;
}

function makeService() {
  const where = sql`1 = 1`;
  const libraryService = { findAll: vi.fn().mockResolvedValue([{ id: 3 }, { id: 5 }]) };
  const queryBuilder = { buildWhere: vi.fn().mockReturnValue(where) };
  const bookRepo = {
    findTagFacets: vi.fn().mockResolvedValue({ tags: [{ id: 1, name: 'fantasy', count: 4 }], truncated: false }),
    countWhere: vi.fn().mockResolvedValue(9),
  };
  const service = new BookTagFacetsService(libraryService as never, queryBuilder as never, bookRepo as never);
  return { service, libraryService, queryBuilder, bookRepo, where };
}

function query(overrides: Partial<ParsedTagFacetsQuery> = {}): ParsedTagFacetsQuery {
  return { excludeTags: [], sort: 'count', limit: 200, ...overrides };
}

describe('BookTagFacetsService', () => {
  it('scopes the facet query to the libraries the user can access', async () => {
    const { service, queryBuilder } = makeService();
    const filter: GroupRule = { type: 'group', join: 'AND', rules: [{ type: 'rule', field: 'tag', operator: 'includesAny', value: ['fantasy'] }] };

    await service.getTagFacets(reqUser(), query({ filter, q: 'dune' }));

    expect(queryBuilder.buildWhere).toHaveBeenCalledWith(filter, {
      accessibleLibraryIds: [3, 5],
      userId: 7,
      q: 'dune',
      timeZone: 'Europe/Lisbon',
      contentFilters,
    });
  });

  it('skips content filters for superusers', async () => {
    const { service, queryBuilder } = makeService();

    await service.getTagFacets(reqUser({ isSuperuser: true }), query());

    expect(queryBuilder.buildWhere.mock.calls[0]![1]).toMatchObject({ contentFilters: undefined });
  });

  it('returns the tag counts alongside the matching book total', async () => {
    const { service, bookRepo, where } = makeService();

    const result = await service.getTagFacets(
      reqUser(),
      query({ excludeTags: ['magic'], onlyTags: ['fantasy', 'epic'], tagSearch: 'fan', sort: 'name', limit: 50 }),
    );

    expect(bookRepo.findTagFacets).toHaveBeenCalledWith({
      where,
      userId: 7,
      excludeTags: ['magic'],
      onlyTags: ['fantasy', 'epic'],
      tagSearch: 'fan',
      sort: 'name',
      limit: 50,
    });
    expect(bookRepo.countWhere).toHaveBeenCalledWith(where);
    expect(result).toEqual({ tags: [{ id: 1, name: 'fantasy', count: 4 }], totalBooks: 9, truncated: false });
  });
});
