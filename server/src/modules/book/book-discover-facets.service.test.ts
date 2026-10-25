import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { compileDiscoverFilter, type DiscoverFacetsRequest, type GroupRule } from '@bookorbit/types';
import { makeUser } from '../../common/test-utils/make-user';
import { LibraryService } from '../library/library.service';
import { BookDiscoverFacetsRepository } from './book-discover-facets.repository';
import { BookDiscoverFacetsService } from './book-discover-facets.service';
import { BookQueryBuilder } from './book-query-builder.service';
import { BookRepository } from './book.repository';

const contentFilters = { includeTagIds: [], excludeTagIds: [5], includeGenreIds: [], excludeGenreIds: [] };

/** `buildWhere` returns a marker holding the filter it was given, so tests can tell the effective filters apart. */
type WhereMarker = { filter: GroupRule | undefined; q: string | undefined };

async function makeService() {
  const libraryService = { resolveBookScope: vi.fn().mockResolvedValue([3]) };
  const queryBuilder = {
    buildWhere: vi.fn((filter: GroupRule | undefined, ctx: { q?: string }) => ({ filter, q: ctx.q }) as WhereMarker),
  };
  const bookRepo = {
    countWhere: vi.fn().mockResolvedValue(10),
    countFormatFacets: vi.fn().mockResolvedValue([
      { format: 'epub', count: 6 },
      { format: 'pdf', count: 0 },
      { format: 'cbz', count: 2 },
    ]),
  };
  const facetsRepo = {
    findRelationValues: vi.fn().mockResolvedValue({ values: [{ value: 'Magic', label: 'Magic', count: 4 }], truncated: false }),
    countRelationValues: vi.fn().mockResolvedValue([]),
    findMetadataValues: vi.fn().mockResolvedValue({ values: [{ value: 'en', label: 'en', count: 7 }], truncated: true }),
    countMetadataValues: vi.fn().mockResolvedValue([]),
    countReadStatuses: vi.fn().mockResolvedValue([
      { value: 'unread', count: 5 },
      { value: 'read', count: 3 },
    ]),
    countUserRatings: vi.fn().mockResolvedValue([
      { rating: 5, count: 2 },
      { rating: null, count: 6 },
    ]),
    findRangeSummary: vi.fn().mockResolvedValue({ min: null, max: null, noneCount: 0 }),
    countRangeBuckets: vi.fn().mockResolvedValue([]),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      BookDiscoverFacetsService,
      { provide: LibraryService, useValue: libraryService },
      { provide: BookQueryBuilder, useValue: queryBuilder },
      { provide: BookRepository, useValue: bookRepo },
      { provide: BookDiscoverFacetsRepository, useValue: facetsRepo },
    ],
  }).compile();

  return { service: moduleRef.get(BookDiscoverFacetsService), libraryService, queryBuilder, bookRepo, facetsRepo };
}

function request(overrides: Partial<DiscoverFacetsRequest> = {}): DiscoverFacetsRequest {
  return { selection: {}, facets: [], ...overrides };
}

const user = makeUser({ id: 7, contentFilters, settings: { timezone: 'Europe/Lisbon' } });

describe('BookDiscoverFacetsService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('scope', () => {
    it('reads the scope from the library access service and narrows to the library', async () => {
      const { service, libraryService, queryBuilder } = await makeService();

      await service.facetsForLibrary(user, 3, request({ q: 'dune', selection: { terms: { genre: { include: ['Fantasy'], exclude: [] } } } }));

      expect(libraryService.resolveBookScope).toHaveBeenCalledWith(user, 3);
      expect(queryBuilder.buildWhere).toHaveBeenCalledWith(compileDiscoverFilter({ terms: { genre: { include: ['Fantasy'], exclude: [] } } }), {
        accessibleLibraryIds: [3],
        implicitLibraryId: 3,
        userId: 7,
        q: 'dune',
        timeZone: 'Europe/Lisbon',
        contentFilters,
      });
    });

    it('rejects a library outside the scope before building any query', async () => {
      const { service, libraryService, queryBuilder, bookRepo } = await makeService();
      libraryService.resolveBookScope.mockResolvedValue([]);

      await expect(service.facetsForLibrary(user, 9, request())).rejects.toBeInstanceOf(ForbiddenException);
      expect(queryBuilder.buildWhere).not.toHaveBeenCalled();
      expect(bookRepo.countWhere).not.toHaveBeenCalled();
    });

    it('skips content filters for superusers', async () => {
      const { service, queryBuilder } = await makeService();

      await service.facetsForLibrary(makeUser({ isSuperuser: true, contentFilters }), 3, request());

      expect(queryBuilder.buildWhere.mock.calls[0]![1]).toMatchObject({ contentFilters: undefined });
    });
  });

  describe('totals', () => {
    it('skips the library total when nothing narrows the selection', async () => {
      const { service, bookRepo } = await makeService();

      const result = await service.facetsForLibrary(user, 3, request());

      expect(bookRepo.countWhere).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ total: 10, libraryTotal: 10, facets: {} });
    });

    it('counts the library total without the selection or the quick search', async () => {
      const { service, bookRepo, queryBuilder } = await makeService();
      bookRepo.countWhere.mockResolvedValueOnce(2).mockResolvedValueOnce(40);

      const result = await service.facetsForLibrary(user, 3, request({ q: 'dune' }));

      expect(result).toMatchObject({ total: 2, libraryTotal: 40 });
      expect(queryBuilder.buildWhere).toHaveBeenCalledWith(undefined, expect.objectContaining({ q: undefined }));
    });
  });

  describe('effective filters', () => {
    const selection = {
      terms: {
        tag: { include: ['Isekai'], exclude: [], mode: 'all' as const },
        genre: { include: ['Fantasy'], exclude: ['Horror'] },
      },
      ranges: { publishedYear: { min: 2000 } },
    };

    it('counts an ANY facet without its own includes and an ALL facet under the full selection', async () => {
      const { service, facetsRepo } = await makeService();

      await service.facetsForLibrary(user, 3, request({ selection, facets: [{ key: 'tag' }, { key: 'genre' }, { key: 'series' }] }));

      const whereFor = (relation: string) =>
        (facetsRepo.findRelationValues.mock.calls.find(([opts]) => opts.relation === relation)![0] as { where: WhereMarker }).where.filter;
      expect(whereFor('tag')).toEqual(compileDiscoverFilter(selection));
      expect(whereFor('series')).toEqual(compileDiscoverFilter(selection));
      expect(whereFor('genre')).toEqual(compileDiscoverFilter(selection, { omitFacet: 'genre', omitIncludesOnly: true }));
    });

    it('builds each distinct effective filter once', async () => {
      const { service, queryBuilder } = await makeService();

      await service.facetsForLibrary(
        user,
        3,
        request({ selection, facets: [{ key: 'tag' }, { key: 'genre' }, { key: 'format' }, { key: 'readStatus' }, { key: 'publishedYear' }] }),
      );

      const builtFilters = queryBuilder.buildWhere.mock.calls.map(([filter]) => JSON.stringify(filter ?? null));
      const full = JSON.stringify(compileDiscoverFilter(selection));
      const omitGenre = JSON.stringify(compileDiscoverFilter(selection, { omitFacet: 'genre', omitIncludesOnly: true }));
      const omitYear = JSON.stringify(compileDiscoverFilter(selection, { omitFacet: 'publishedYear' }));
      expect(builtFilters.filter((filter) => filter === full)).toHaveLength(1);
      expect(builtFilters.filter((filter) => filter === omitGenre)).toHaveLength(1);
      expect(builtFilters.filter((filter) => filter === omitYear)).toHaveLength(1);
    });

    it('counts the none bucket as the effective filter plus isEmpty', async () => {
      const { service, queryBuilder, bookRepo } = await makeService();
      bookRepo.countWhere.mockImplementation((where: WhereMarker) =>
        Promise.resolve((where.filter?.rules.at(-1) as { operator?: string })?.operator === 'isEmpty' ? 4 : 10),
      );

      const result = await service.facetsForLibrary(user, 3, request({ selection, q: 'x', facets: [{ key: 'genre' }] }));

      const base = compileDiscoverFilter(selection, { omitFacet: 'genre', omitIncludesOnly: true })!;
      expect(queryBuilder.buildWhere).toHaveBeenCalledWith(
        { ...base, rules: [...base.rules, { type: 'rule', field: 'genre', operator: 'isEmpty' }] },
        expect.objectContaining({ q: 'x' }),
      );
      expect(result.facets.genre).toMatchObject({ noneCount: 4 });
    });
  });

  describe('term facets', () => {
    it('echoes every selected value with its count, or zero and the raw value when it is gone', async () => {
      const { service, facetsRepo } = await makeService();
      facetsRepo.countRelationValues.mockResolvedValue([{ value: '12', label: 'Ann Leckie', count: 3 }]);

      const result = await service.facetsForLibrary(
        user,
        3,
        request({
          selection: { terms: { authorId: { include: ['12', '99'], exclude: ['40'] } } },
          facets: [{ key: 'authorId', limit: 5, search: 'an', sort: 'alpha' }],
        }),
      );

      expect(facetsRepo.findRelationValues).toHaveBeenCalledWith(
        expect.objectContaining({ relation: 'author', search: 'an', sort: 'alpha', limit: 5, excludeValues: ['12', '99', '40'] }),
      );
      expect(result.facets.authorId).toEqual({
        kind: 'term',
        key: 'authorId',
        values: [{ value: 'Magic', label: 'Magic', count: 4 }],
        selected: [
          { value: '12', label: 'Ann Leckie', count: 3 },
          { value: '99', label: '99', count: 0 },
          { value: '40', label: '40', count: 0 },
        ],
        noneCount: 10,
        truncated: false,
      });
    });

    it('lists metadata facets with the default limit and sort', async () => {
      const { service, facetsRepo } = await makeService();

      const result = await service.facetsForLibrary(user, 3, request({ facets: [{ key: 'language' }] }));

      expect(facetsRepo.findMetadataValues).toHaveBeenCalledWith(
        expect.objectContaining({ column: 'language', sort: 'count', limit: 30, excludeValues: [] }),
      );
      expect(result.facets.language).toMatchObject({ truncated: true, values: [{ value: 'en', count: 7 }] });
    });

    it('drops empty formats, applies the search and reports no none bucket', async () => {
      const { service } = await makeService();

      const all = await service.facetsForLibrary(user, 3, request({ facets: [{ key: 'format' }] }));
      const searched = await service.facetsForLibrary(user, 3, request({ facets: [{ key: 'format', search: 'CB' }] }));

      expect(all.facets.format).toMatchObject({
        values: [
          { value: 'epub', count: 6 },
          { value: 'cbz', count: 2 },
        ],
        noneCount: 0,
        truncated: false,
      });
      expect(searched.facets.format).toMatchObject({ values: [{ value: 'cbz', count: 2 }] });
    });

    it('cuts fixed facets at the limit', async () => {
      const { service } = await makeService();

      const result = await service.facetsForLibrary(user, 3, request({ facets: [{ key: 'readStatus', limit: 1, sort: 'alpha' }] }));

      expect(result.facets.readStatus).toMatchObject({ values: [{ value: 'read', count: 3 }], truncated: true, noneCount: 0 });
    });

    it('takes the rating none bucket from the unrated books and echoes selected ratings', async () => {
      const { service, facetsRepo } = await makeService();

      const result = await service.facetsForLibrary(
        user,
        3,
        request({ selection: { terms: { rating: { include: ['5'], exclude: ['1'] } } }, facets: [{ key: 'rating' }] }),
      );

      expect(facetsRepo.countUserRatings).toHaveBeenCalledTimes(1);
      expect(result.facets.rating).toMatchObject({
        values: [],
        selected: [
          { value: '5', count: 2 },
          { value: '1', count: 0 },
        ],
        noneCount: 6,
      });
    });

    it('reads statuses for the requesting user and ignores unknown status values', async () => {
      const { service, facetsRepo } = await makeService();
      facetsRepo.countReadStatuses.mockResolvedValue([
        { value: 'unread', count: 5 },
        { value: 'legacy', count: 1 },
      ]);

      const result = await service.facetsForLibrary(user, 3, request({ facets: [{ key: 'readStatus' }] }));

      expect(facetsRepo.countReadStatuses).toHaveBeenCalledWith(expect.anything(), 7);
      expect(result.facets.readStatus).toMatchObject({ values: [{ value: 'unread', count: 5 }] });
    });
  });

  describe('range facets', () => {
    it('splits a numeric range into at most 20 contiguous buckets', async () => {
      const { service, facetsRepo } = await makeService();
      facetsRepo.findRangeSummary.mockResolvedValue({ min: 2000, max: 2030, noneCount: 3 });
      facetsRepo.countRangeBuckets.mockResolvedValue([
        { bucket: 0, count: 4 },
        { bucket: 15, count: 1 },
      ]);

      const result = await service.facetsForLibrary(user, 3, request({ facets: [{ key: 'publishedYear' }] }));
      const facet = result.facets.publishedYear as { buckets: Array<{ from: number; to: number; count: number }> };

      expect(facetsRepo.countRangeBuckets).toHaveBeenCalledWith('publishedYear', expect.anything(), 2000, 2);
      expect(facet.buckets).toHaveLength(16);
      expect(facet.buckets[0]).toEqual({ from: 2000, to: 2001, count: 4 });
      expect(facet.buckets[1]).toEqual({ from: 2002, to: 2003, count: 0 });
      expect(facet.buckets[15]).toEqual({ from: 2030, to: 2030, count: 1 });
      expect(result.facets.publishedYear).toMatchObject({ kind: 'range', min: 2000, max: 2030, noneCount: 3 });
    });

    it('reports added dates as UTC month bounds', async () => {
      const { service, facetsRepo } = await makeService();
      facetsRepo.findRangeSummary.mockResolvedValue({ min: 2024 * 12 + 1, max: 2024 * 12 + 2, noneCount: 0 });
      facetsRepo.countRangeBuckets.mockResolvedValue([{ bucket: 1, count: 5 }]);

      const result = await service.facetsForLibrary(user, 3, request({ facets: [{ key: 'addedAt' }] }));

      expect(result.facets.addedAt).toEqual({
        kind: 'range',
        key: 'addedAt',
        min: '2024-02-01',
        max: '2024-03-31',
        buckets: [
          { from: '2024-02-01', to: '2024-02-29', count: 0 },
          { from: '2024-03-01', to: '2024-03-31', count: 5 },
        ],
        noneCount: 0,
      });
    });

    it('returns no buckets when no book has a value', async () => {
      const { service, facetsRepo } = await makeService();
      facetsRepo.findRangeSummary.mockResolvedValue({ min: null, max: null, noneCount: 8 });

      const result = await service.facetsForLibrary(user, 3, request({ facets: [{ key: 'pageCount' }] }));

      expect(result.facets.pageCount).toEqual({ kind: 'range', key: 'pageCount', min: null, max: null, buckets: [], noneCount: 8 });
      expect(facetsRepo.countRangeBuckets).not.toHaveBeenCalled();
    });
  });

  it('computes at most three facets at a time', async () => {
    const { service, facetsRepo } = await makeService();
    let inFlight = 0;
    let peak = 0;
    const slowList = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { values: [], truncated: false };
    };
    facetsRepo.findRelationValues.mockImplementation(slowList);
    facetsRepo.findMetadataValues.mockImplementation(slowList);

    await service.facetsForLibrary(
      user,
      3,
      request({ facets: [{ key: 'tag' }, { key: 'genre' }, { key: 'authorId' }, { key: 'series' }, { key: 'language' }, { key: 'publisher' }] }),
    );

    expect(peak).toBe(3);
  });

  describe('logging', () => {
    it('logs slow requests at 300 ms or more', async () => {
      const { service } = await makeService();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValue(1_300);

      await service.facetsForLibrary(user, 3, request({ facets: [{ key: 'tag' }] }));

      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/^\[book\.discover_facets\] \[end\] userId=7 libraryId=3 facetCount=1 .*durationMs=300 - slow query$/),
      );
    });

    it('logs unexpected failures with a sanitized message and rethrows', async () => {
      const { service, facetsRepo } = await makeService();
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      facetsRepo.findRelationValues.mockRejectedValue(new TypeError('bad "quote"\nline'));

      await expect(service.facetsForLibrary(user, 3, request({ facets: [{ key: 'tag' }] }))).rejects.toBeInstanceOf(TypeError);

      const message = error.mock.calls[0]![0] as string;
      expect(message).toMatch(/^\[book\.discover_facets\] \[fail\] userId=7 libraryId=3 facetCount=1 durationMs=\d+ errorClass=TypeError error="/);
      expect(message).not.toContain('\n');
    });

    it('does not log HTTP errors as failures', async () => {
      const { service, libraryService } = await makeService();
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      libraryService.resolveBookScope.mockRejectedValue(new NotFoundException());

      await expect(service.facetsForLibrary(user, 3, request())).rejects.toBeInstanceOf(NotFoundException);
      expect(error).not.toHaveBeenCalled();
    });
  });
});
