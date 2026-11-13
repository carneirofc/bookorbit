import {
  DISCOVER_RANGE_FACETS,
  DISCOVER_TERM_FACETS,
  compileDiscoverFilter,
  discoverTermMode,
  hasDiscoverRangeSelection,
  hasDiscoverTermIncludes,
  type BooksPage,
  type DiscoverFacetKey,
  type DiscoverFacetsRequest,
  type DiscoverFacetsResponse,
  type DiscoverRangeFacetKey,
  type DiscoverRangeFacetResult,
  type DiscoverSelection,
  type DiscoverTermFacetKey,
  type DiscoverTermFacetResult,
  type GroupRule,
  type Rule,
} from '@bookorbit/types';
import { eq } from 'drizzle-orm';

import {
  authors,
  bookAuthors,
  bookFiles,
  bookGenres,
  bookMetadata,
  books,
  bookSeries,
  bookSeriesMemberships,
  bookTags,
  genres,
  tags,
  userBookRatings,
  userBookStatus,
  userContentFilterTags,
  users,
} from '../src/db/schema';
import {
  authHeader,
  closeMetadataWriteE2EContext,
  createLibraryWithFolder,
  createMetadataWriteE2EContext,
  createUserAndLogin,
  grantLibraryAccess,
  type MetadataWriteE2EContext,
  type TestUserSession,
} from './e2e/metadata-write/metadata-write-harness';

const SCENARIO_TIMEOUT_MS = 180_000;

type Status = 'reading' | 'read' | 'want_to_read';

type SeedSpec = {
  title: string;
  tags?: string[];
  genres?: string[];
  authors?: string[];
  series?: string[];
  language?: string;
  publisher?: string;
  year?: number;
  pages?: number;
  addedAt: string;
  format?: string;
  status?: 'present' | 'processing';
  adminStatus?: Status;
  viewerStatus?: Status;
  adminRating?: number;
  viewerRating?: number;
};

const SEEDS: SeedSpec[] = [
  {
    title: 'Dragon Isekai One',
    tags: ['Isekai', 'Reincarnation', 'Magic'],
    genres: ['Fantasy'],
    authors: ['Ann Leckie'],
    series: ['Dragon Saga'],
    language: 'en',
    publisher: 'Yen Press',
    year: 2016,
    pages: 220,
    addedAt: '2024-01-10T12:00:00Z',
    adminStatus: 'read',
    adminRating: 5,
  },
  {
    title: 'Dragon Isekai Two',
    tags: ['Isekai', 'Reincarnation', 'Harem'],
    genres: ['Fantasy', 'Romance'],
    authors: ['Ann Leckie', 'Ken Liu'],
    series: ['Dragon Saga'],
    language: 'en',
    publisher: 'Yen Press',
    year: 2017,
    pages: 240,
    addedAt: '2024-02-03T08:00:00Z',
    adminStatus: 'reading',
    viewerStatus: 'read',
    adminRating: 4,
    viewerRating: 2,
  },
  {
    title: 'Isekai Without Magic',
    tags: ['Isekai'],
    genres: ['Fantasy'],
    authors: ['Joanne Harris'],
    language: 'ja',
    publisher: 'Kodansha',
    year: 2019,
    pages: 180,
    addedAt: '2024-02-28T23:30:00Z',
    format: 'pdf',
    viewerStatus: 'reading',
  },
  {
    title: 'Hard Science',
    tags: ['Space'],
    genres: ['Science Fiction'],
    authors: ['Ken Liu'],
    series: ['Remembrance'],
    language: 'en',
    publisher: 'Tor',
    year: 2008,
    pages: 400,
    addedAt: '2024-03-15T10:00:00Z',
    adminStatus: 'want_to_read',
    adminRating: 3,
    viewerRating: 5,
  },
  {
    title: 'Hard Science Returns',
    tags: ['Space', 'Magic'],
    genres: ['Science Fiction', 'Fantasy'],
    authors: ['Ken Liu'],
    series: ['Remembrance'],
    language: 'en',
    publisher: 'Tor',
    year: 2010,
    pages: 520,
    addedAt: '2024-05-01T10:00:00Z',
    format: 'pdf',
    adminRating: 5,
  },
  {
    title: 'Le Dragon',
    tags: ['Magic'],
    genres: ['Fantasy'],
    authors: ['Joanne Harris'],
    language: 'fr',
    publisher: '',
    year: 1999,
    pages: 300,
    addedAt: '2024-05-20T10:00:00Z',
    format: 'cbz',
    adminStatus: 'read',
  },
  {
    title: 'Untagged Memoir',
    authors: ['Joanne Harris'],
    language: 'en',
    addedAt: '2024-06-01T10:00:00Z',
    viewerStatus: 'want_to_read',
  },
  {
    title: 'Anonymous Pamphlet',
    tags: ['Harem'],
    addedAt: '2024-07-04T10:00:00Z',
    year: 2021,
    pages: 40,
    adminRating: 1,
  },
  {
    title: 'Dragon Processing',
    tags: ['Isekai', 'Magic'],
    genres: ['Fantasy'],
    authors: ['Ann Leckie'],
    addedAt: '2024-07-05T10:00:00Z',
    status: 'processing',
    adminStatus: 'read',
    adminRating: 5,
  },
];

const VISIBLE_SEED_COUNT = SEEDS.filter((seed) => seed.status !== 'processing').length;

const ALL_FACETS: DiscoverFacetKey[] = [...DISCOVER_TERM_FACETS, ...DISCOVER_RANGE_FACETS];

/** The listing rule that holds exactly the books carrying `value` for a term facet. */
function hasValueRule(key: DiscoverTermFacetKey, value: string): Rule {
  if (key === 'rating') return { type: 'rule', field: 'rating', operator: 'eq', value: Number(value) };
  if (key === 'authorId') return { type: 'rule', field: 'authorId', operator: 'includesAny', value: [Number(value)] };
  return { type: 'rule', field: key, operator: 'includesAny', value: [value] };
}

function andRule(filter: GroupRule | undefined, rule: Rule): GroupRule {
  return { type: 'group', join: 'AND', rules: [...(filter?.rules ?? []), rule] };
}

/** The filter a facet's counts are read under, per the Discover count rules. */
function baseFilterFor(key: DiscoverFacetKey, selection: DiscoverSelection): GroupRule | undefined {
  if ((DISCOVER_RANGE_FACETS as readonly string[]).includes(key)) {
    const rangeKey = key as DiscoverRangeFacetKey;
    return hasDiscoverRangeSelection(selection.ranges?.[rangeKey])
      ? compileDiscoverFilter(selection, { omitFacet: rangeKey })
      : compileDiscoverFilter(selection);
  }
  const termKey = key as DiscoverTermFacetKey;
  const term = selection.terms?.[termKey];
  if (discoverTermMode(termKey, term) === 'any' && hasDiscoverTermIncludes(term)) {
    return compileDiscoverFilter(selection, { omitFacet: termKey, omitIncludesOnly: true });
  }
  return compileDiscoverFilter(selection);
}

type Scenario = { name: string; selection: DiscoverSelection; q?: string };

describe('Discover facets (e2e)', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  let ctx!: MetadataWriteE2EContext;
  let libraryId!: number;
  let adminId!: number;
  let viewer!: TestUserSession;
  const authorIds = new Map<string, number>();

  async function upsertNamed(table: typeof tags | typeof genres, name: string): Promise<number> {
    const [row] = await ctx.db.insert(table).values({ name }).onConflictDoNothing().returning({ id: table.id });
    if (row) return row.id;
    const [existing] = await ctx.db.select({ id: table.id }).from(table).where(eq(table.name, name)).limit(1);
    return existing!.id;
  }

  beforeAll(async () => {
    ctx = await createMetadataWriteE2EContext();
    const library = await createLibraryWithFolder(ctx, { name: 'discover-facets' });
    libraryId = library.libraryId;

    const [admin] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.username, 'metadata-write-e2e-admin')).limit(1);
    if (!admin) throw new Error('e2e admin user not found');
    adminId = admin.id;
    viewer = await createUserAndLogin(ctx);
    await grantLibraryAccess(ctx, viewer.userId, libraryId, 'viewer');

    const seriesIds = new Map<string, number>();
    let ino = 920_000;
    for (const [index, seed] of SEEDS.entries()) {
      const [book] = await ctx.db
        .insert(books)
        .values({
          libraryId,
          libraryFolderId: library.libraryFolderId,
          folderPath: `/seed/discover-${index}`,
          status: seed.status ?? 'present',
          addedAt: new Date(seed.addedAt),
        })
        .returning({ id: books.id });
      const bookId = book!.id;
      await ctx.db.insert(bookMetadata).values({
        bookId,
        title: seed.title,
        language: seed.language ?? null,
        publisher: seed.publisher ?? null,
        publishedYear: seed.year ?? null,
        pageCount: seed.pages ?? null,
      });
      const format = seed.format ?? 'epub';
      const [file] = await ctx.db
        .insert(bookFiles)
        .values({
          bookId,
          libraryFolderId: library.libraryFolderId,
          absolutePath: `/seed/discover-${index}/book.${format}`,
          relPath: `discover-${index}/book.${format}`,
          ino: BigInt(ino++),
          format,
          role: 'content',
        })
        .returning({ id: bookFiles.id });
      await ctx.db.update(books).set({ primaryFileId: file!.id }).where(eq(books.id, bookId));

      for (const name of seed.tags ?? []) await ctx.db.insert(bookTags).values({ bookId, tagId: await upsertNamed(tags, name) });
      for (const name of seed.genres ?? []) await ctx.db.insert(bookGenres).values({ bookId, genreId: await upsertNamed(genres, name) });
      for (const [order, name] of (seed.authors ?? []).entries()) {
        let authorId = authorIds.get(name);
        if (authorId === undefined) {
          const [row] = await ctx.db.insert(authors).values({ name, sortName: name }).returning({ id: authors.id });
          authorId = row!.id;
          authorIds.set(name, authorId);
        }
        await ctx.db.insert(bookAuthors).values({ bookId, authorId, displayOrder: order });
      }
      for (const [order, name] of (seed.series ?? []).entries()) {
        let seriesId = seriesIds.get(name);
        if (seriesId === undefined) {
          const [row] = await ctx.db.insert(bookSeries).values({ name, normalizedName: name.toLowerCase() }).returning({ id: bookSeries.id });
          seriesId = row!.id;
          seriesIds.set(name, seriesId);
        }
        await ctx.db.insert(bookSeriesMemberships).values({ bookId, seriesId, seriesIndex: String(index + 1), displayOrder: order });
      }

      const statuses = [
        ...(seed.adminStatus ? [{ userId: adminId, status: seed.adminStatus }] : []),
        ...(seed.viewerStatus ? [{ userId: viewer.userId, status: seed.viewerStatus }] : []),
      ];
      if (statuses.length > 0) {
        await ctx.db.insert(userBookStatus).values(statuses.map((row) => ({ ...row, bookId, source: 'manual' as const })));
      }
      const ratings = [
        ...(seed.adminRating ? [{ userId: adminId, rating: seed.adminRating }] : []),
        ...(seed.viewerRating ? [{ userId: viewer.userId, rating: seed.viewerRating }] : []),
      ];
      if (ratings.length > 0) await ctx.db.insert(userBookRatings).values(ratings.map((row) => ({ ...row, bookId })));
    }
  });

  afterAll(async () => {
    await closeMetadataWriteE2EContext(ctx);
  });

  async function postFacets(token: string, body: unknown, id = libraryId) {
    return ctx.app.inject({ method: 'POST', url: `/api/v1/libraries/${id}/discover/facets`, headers: authHeader(token), payload: body as object });
  }

  async function fetchFacets(token: string, body: DiscoverFacetsRequest): Promise<DiscoverFacetsResponse> {
    const response = await postFacets(token, body);
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as DiscoverFacetsResponse;
  }

  async function listingTotal(token: string, filter: GroupRule | undefined, q?: string): Promise<number> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/libraries/${libraryId}/books`,
      headers: authHeader(token),
      payload: {
        ...(filter ? { filter } : {}),
        ...(q !== undefined ? { q } : {}),
        sort: [{ field: 'title', dir: 'asc' }],
        pagination: { page: 0, size: 1 },
        collapseSeries: false,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return (response.json() as BooksPage).total;
  }

  function scenarios(): Scenario[] {
    const ann = String(authorIds.get('Ann Leckie'));
    const ken = String(authorIds.get('Ken Liu'));
    return [
      { name: 'no selection', selection: {} },
      {
        name: 'ALL tags with an exclusion, ANY genre and unread',
        selection: {
          terms: {
            tag: { include: ['Isekai'], exclude: ['Harem'], mode: 'all' },
            genre: { include: ['Fantasy'], exclude: [] },
            readStatus: { include: ['unread', 'read'], exclude: [] },
          },
        },
      },
      {
        name: 'ANY genres with the none bucket, an author, a language exclusion and a year range',
        selection: {
          terms: {
            genre: { include: ['Fantasy', 'Science Fiction'], exclude: [], includeNone: true },
            authorId: { include: [ann, ken], exclude: [] },
            language: { include: [], exclude: ['fr'] },
          },
          ranges: { publishedYear: { min: 2009 } },
        },
      },
      {
        name: 'quick search with series, rating and format',
        q: 'dragon',
        selection: {
          terms: {
            series: { include: ['Dragon Saga'], exclude: [] },
            rating: { include: ['5'], exclude: [], includeNone: true },
            format: { include: ['epub'], exclude: [] },
          },
        },
      },
      {
        name: 'ANY tags with none, publisher present, page and added ranges',
        selection: {
          terms: {
            tag: { include: ['Space'], exclude: ['Harem'], mode: 'any', includeNone: true },
            publisher: { include: [], exclude: [], excludeNone: true },
            rating: { include: [], exclude: ['3'] },
          },
          ranges: { pageCount: { min: 100, max: 450 }, addedAt: { min: '2024-02-01', max: '2024-05-31' } },
        },
      },
      {
        name: 'more included tags than one rule holds',
        selection: { terms: { tag: { include: ['Isekai', ...Array.from({ length: 24 }, (_, i) => `Missing ${i}`)], exclude: [], mode: 'any' } } },
      },
    ];
  }

  async function assertInvariant(token: string, scenario: Scenario): Promise<void> {
    const { selection, q } = scenario;
    const response = await fetchFacets(token, { selection, ...(q !== undefined ? { q } : {}), facets: ALL_FACETS.map((key) => ({ key })) });

    expect(response.total).toBe(await listingTotal(token, compileDiscoverFilter(selection), q));
    expect(response.libraryTotal).toBe(VISIBLE_SEED_COUNT);

    for (const key of DISCOVER_TERM_FACETS) {
      const facet = response.facets[key] as DiscoverTermFacetResult;
      expect(facet.kind).toBe('term');
      const base = baseFilterFor(key, selection);
      const term = selection.terms?.[key];
      const excluded = new Set(term?.exclude ?? []);
      for (const value of [...facet.values, ...facet.selected]) {
        const expected = excluded.has(value.value) ? 0 : await listingTotal(token, andRule(base, hasValueRule(key, value.value)), q);
        expect(value.count, `${scenario.name}: ${key}=${value.value}`).toBe(expected);
      }
      for (const value of facet.values) expect(value.count).toBeGreaterThan(0);
      if (['tag', 'genre', 'authorId', 'series', 'language', 'publisher', 'rating'].includes(key)) {
        const noneRule: Rule = { type: 'rule', field: key, operator: 'isEmpty' };
        expect(facet.noneCount, `${scenario.name}: ${key} none`).toBe(await listingTotal(token, andRule(base, noneRule), q));
      } else {
        expect(facet.noneCount).toBe(0);
      }
    }

    for (const key of DISCOVER_RANGE_FACETS) {
      const facet = response.facets[key] as DiscoverRangeFacetResult;
      const base = baseFilterFor(key, selection);
      const baseTotal = await listingTotal(token, base, q);
      const bucketSum = facet.buckets.reduce((sum, bucket) => sum + bucket.count, 0);
      expect(bucketSum + facet.noneCount, `${scenario.name}: ${key} buckets`).toBe(baseTotal);
      for (const bucket of facet.buckets) {
        const between: Rule =
          key === 'addedAt'
            ? { type: 'rule', field: 'addedAt', operator: 'between', value: `${bucket.from}T00:00:00.000Z`, valueTo: `${bucket.to}T23:59:59.999Z` }
            : { type: 'rule', field: key, operator: 'between', value: bucket.from as number, valueTo: bucket.to as number };
        expect(bucket.count, `${scenario.name}: ${key} ${bucket.from}..${bucket.to}`).toBe(await listingTotal(token, andRule(base, between), q));
      }
      if (key !== 'addedAt') {
        const noneRule: Rule = { type: 'rule', field: key, operator: 'isEmpty' };
        expect(facet.noneCount).toBe(await listingTotal(token, andRule(base, noneRule), q));
      }
    }
  }

  for (const persona of ['superuser admin', 'viewer'] as const) {
    it(`keeps every facet count equal to the listing total as the ${persona}`, async () => {
      const token = persona === 'viewer' ? viewer.accessToken : ctx.adminToken;
      for (const scenario of scenarios()) await assertInvariant(token, scenario);
    });
  }

  it('counts ALL-mode tags as a drill-down and ANY-mode genres disjunctively', async () => {
    const response = await fetchFacets(ctx.adminToken, {
      selection: { terms: { tag: { include: ['Isekai'], exclude: [], mode: 'all' }, genre: { include: ['Romance'], exclude: [] } } },
      facets: [{ key: 'tag' }, { key: 'genre' }],
    });
    const tag = response.facets.tag as DiscoverTermFacetResult;
    const genre = response.facets.genre as DiscoverTermFacetResult;

    expect(response.total).toBe(1);
    expect(tag.selected).toEqual([{ value: 'Isekai', label: 'Isekai', count: 1 }]);
    expect(tag.values.map((value) => value.value).sort()).toEqual(['Harem', 'Reincarnation']);
    expect(genre.selected).toEqual([{ value: 'Romance', label: 'Romance', count: 1 }]);
    expect(genre.values).toEqual([{ value: 'Fantasy', label: 'Fantasy', count: 3 }]);
  });

  it('matches authors by id, unlike the substring author rule', async () => {
    const ann = String(authorIds.get('Ann Leckie'));
    const response = await fetchFacets(ctx.adminToken, {
      selection: { terms: { authorId: { include: [ann], exclude: [] } } },
      facets: [{ key: 'authorId' }],
    });
    const facet = response.facets.authorId as DiscoverTermFacetResult;

    expect(response.total).toBe(2);
    expect(facet.selected).toEqual([{ value: ann, label: 'Ann Leckie', count: 2 }]);
    const substring = await listingTotal(ctx.adminToken, {
      type: 'group',
      join: 'AND',
      rules: [{ type: 'rule', field: 'author', operator: 'includesAny', value: ['Ann'] }],
    });
    expect(substring).toBe(5);
  });

  it('reads status and rating per user', async () => {
    const body: DiscoverFacetsRequest = { selection: {}, facets: [{ key: 'readStatus' }, { key: 'rating' }] };
    const [admin, viewerFacets] = await Promise.all([fetchFacets(ctx.adminToken, body), fetchFacets(viewer.accessToken, body)]);
    const counts = (result: DiscoverFacetsResponse, key: 'readStatus' | 'rating') =>
      Object.fromEntries((result.facets[key] as DiscoverTermFacetResult).values.map((value) => [value.value, value.count]));

    expect(counts(admin, 'readStatus')).toEqual({ unread: 4, read: 2, reading: 1, want_to_read: 1 });
    expect(counts(viewerFacets, 'readStatus')).toEqual({ unread: 5, read: 1, reading: 1, want_to_read: 1 });
    expect(counts(admin, 'rating')).toEqual({ '5': 2, '4': 1, '3': 1, '1': 1 });
    expect((admin.facets.rating as DiscoverTermFacetResult).noneCount).toBe(3);
    expect(counts(viewerFacets, 'rating')).toEqual({ '5': 1, '2': 1 });
  });

  it('summarizes ranges in contiguous buckets', async () => {
    const response = await fetchFacets(ctx.adminToken, { selection: {}, facets: [{ key: 'publishedYear' }, { key: 'addedAt' }] });
    const year = response.facets.publishedYear as DiscoverRangeFacetResult;
    const added = response.facets.addedAt as DiscoverRangeFacetResult;

    expect(year).toMatchObject({ min: 1999, max: 2021, noneCount: 1 });
    expect(year.buckets.length).toBeLessThanOrEqual(20);
    expect(year.buckets[0]!.from).toBe(1999);
    expect(year.buckets.at(-1)!.to).toBe(2021);
    expect(added).toMatchObject({ min: '2024-01-01', max: '2024-07-31', noneCount: 0 });
    expect(added.buckets.map((bucket) => bucket.count)).toEqual([1, 2, 1, 0, 2, 1, 1]);
  });

  it('limits, searches and sorts within a facet and echoes selected values that no longer exist', async () => {
    const limited = await fetchFacets(ctx.adminToken, { selection: {}, facets: [{ key: 'tag', limit: 2 }] });
    const tag = limited.facets.tag as DiscoverTermFacetResult;
    expect(tag.truncated).toBe(true);
    expect(tag.values).toEqual([
      { value: 'Isekai', label: 'Isekai', count: 3 },
      { value: 'Magic', label: 'Magic', count: 3 },
    ]);

    const searched = await fetchFacets(ctx.adminToken, {
      selection: { terms: { tag: { include: ['Vanished Tag'], exclude: [], mode: 'any' } } },
      facets: [{ key: 'tag', search: 'ISEK', sort: 'alpha' }],
    });
    const found = searched.facets.tag as DiscoverTermFacetResult;
    expect(found.values).toEqual([{ value: 'Isekai', label: 'Isekai', count: 3 }]);
    expect(found.selected).toEqual([{ value: 'Vanished Tag', label: 'Vanished Tag', count: 0 }]);
    expect(found.truncated).toBe(false);
  });

  it('returns only the totals for an empty facet list', async () => {
    const response = await fetchFacets(ctx.adminToken, { selection: { terms: { genre: { include: ['Romance'], exclude: [] } } }, facets: [] });
    expect(response).toEqual({ total: 1, libraryTotal: VISIBLE_SEED_COUNT, facets: {} });
  });

  it('hides books and values a content filter removes', async () => {
    const filtered = await createUserAndLogin(ctx);
    await grantLibraryAccess(ctx, filtered.userId, libraryId, 'viewer');
    const [harem] = await ctx.db.select({ id: tags.id }).from(tags).where(eq(tags.name, 'Harem')).limit(1);
    await ctx.db.insert(userContentFilterTags).values({ userId: filtered.userId, filterType: 'exclude', tagId: harem!.id });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: filtered.username, password: filtered.password },
    });
    const token = (login.json() as { accessToken: string }).accessToken;

    const response = await fetchFacets(token, { selection: {}, facets: [{ key: 'tag', limit: 500 }] });
    expect(response.libraryTotal).toBe(VISIBLE_SEED_COUNT - 2);
    expect((response.facets.tag as DiscoverTermFacetResult).values.map((value) => value.value)).not.toContain('Harem');
  });

  it('keeps random paging stable for one seed through the existing listing', async () => {
    const filter = compileDiscoverFilter({ terms: { genre: { include: ['Fantasy', 'Science Fiction'], exclude: [] } } });
    const page = async (index: number) => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/libraries/${libraryId}/books`,
        headers: authHeader(ctx.adminToken),
        payload: {
          filter,
          sort: [{ field: 'random', dir: 'asc' }],
          randomSeed: 1234567,
          pagination: { page: index, size: 3 },
          collapseSeries: false,
        },
      });
      return (response.json() as BooksPage).items.map((item) => item.id);
    };
    const [first, second] = [await page(0), await page(1)];
    expect(first.filter((id) => second.includes(id))).toEqual([]);
    expect([...(await page(0)), ...(await page(1))]).toEqual([...first, ...second]);
  });

  describe('access and validation', () => {
    it('denies a user without library access', async () => {
      const outsider = await createUserAndLogin(ctx);
      const response = await postFacets(outsider.accessToken, { selection: {}, facets: [] });
      expect(response.statusCode).toBe(403);
    });

    it('does not name a selected author who only writes in a library the viewer cannot read', async () => {
      const hidden = await createLibraryWithFolder(ctx, { name: 'discover-facets-hidden' });
      const [book] = await ctx.db
        .insert(books)
        .values({ libraryId: hidden.libraryId, libraryFolderId: hidden.libraryFolderId, folderPath: '/seed/discover-hidden', status: 'present' })
        .returning({ id: books.id });
      const [author] = await ctx.db.insert(authors).values({ name: 'Hidden Author', sortName: 'Hidden Author' }).returning({ id: authors.id });
      await ctx.db.insert(bookAuthors).values({ bookId: book!.id, authorId: author!.id, displayOrder: 0 });
      const hiddenId = String(author!.id);

      const response = await fetchFacets(viewer.accessToken, {
        selection: { terms: { authorId: { include: [hiddenId], exclude: [] } } },
        facets: [{ key: 'authorId' }],
      });

      expect((response.facets.authorId as DiscoverTermFacetResult).selected).toEqual([{ value: hiddenId, label: hiddenId, count: 0 }]);
    });

    it('returns 404 for an unknown library', async () => {
      const response = await postFacets(ctx.adminToken, { selection: {}, facets: [] }, 987_654);
      expect(response.statusCode).toBe(404);
    });

    it.each([
      ['mode all on a single-valued facet', { selection: { terms: { language: { include: ['en'], exclude: [], mode: 'all' } } }, facets: [] }],
      ['a value both included and excluded', { selection: { terms: { tag: { include: ['a'], exclude: ['a'] } } }, facets: [] }],
      ['an unknown facet key', { selection: {}, facets: [{ key: 'colour' }] }],
      ['duplicate facet keys', { selection: {}, facets: [{ key: 'tag' }, { key: 'tag' }] }],
      ['an unknown body field', { selection: {}, facets: [], filter: {} }],
      ['a facet limit above 500', { selection: {}, facets: [{ key: 'tag', limit: 501 }] }],
      ['a non-numeric author id', { selection: { terms: { authorId: { include: ['Ann'], exclude: [] } } }, facets: [] }],
      ['a none bucket on format', { selection: { terms: { format: { include: [], exclude: [], includeNone: true } } }, facets: [] }],
      ['an inverted range', { selection: { ranges: { publishedYear: { min: 2020, max: 2000 } } }, facets: [] }],
    ])('rejects %s with 400', async (_name, body) => {
      const response = await postFacets(ctx.adminToken, body);
      expect(response.statusCode).toBe(400);
    });
  });
});
