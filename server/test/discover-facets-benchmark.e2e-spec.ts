import type { DiscoverFacetKey, DiscoverFacetsRequest, DiscoverSelection } from '@bookorbit/types';
import { eq, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { users } from '../src/db/schema';
import {
  authHeader,
  closeMetadataWriteE2EContext,
  createLibraryWithFolder,
  createMetadataWriteE2EContext,
  type MetadataWriteE2EContext,
} from './e2e/metadata-write/metadata-write-harness';

/**
 * Opt-in latency benchmark for POST /libraries/:id/discover/facets, recorded in
 * docs/DISCOVER_VIEW.md. Skipped unless DISCOVER_BENCH_BOOKS is set:
 *
 *   DISCOVER_BENCH_BOOKS=5000 pnpm run e2e:run -- discover-facets test/discover-facets-benchmark.e2e-spec.ts --no-file-parallelism
 *
 * DISCOVER_BENCH_RUNS sets the timed runs per case (default 15); DISCOVER_BENCH_PLAN=<ms> prints the
 * SQL and plan of every facet query slower than that.
 *
 * It seeds a synthetic library with generate_series (no data dump), then prints p50/p95 request
 * latency and the EXPLAIN ANALYZE execution time of every facet query for 0, 1, 3 and 6 active facets.
 */
const BOOKS = Number(process.env.DISCOVER_BENCH_BOOKS ?? 0);
const RUNS = Number(process.env.DISCOVER_BENCH_RUNS ?? 15);
const dialect = new PgDialect();
const TAGS = 2000;
const GENRES = 40;

const DEFAULT_FACETS: DiscoverFacetKey[] = ['tag', 'genre', 'readStatus'];
const ALL_FACETS: DiscoverFacetKey[] = [
  'tag',
  'genre',
  'authorId',
  'series',
  'language',
  'format',
  'publisher',
  'readStatus',
  'rating',
  'publishedYear',
  'pageCount',
  'addedAt',
];

const SELECTIONS: Array<{ active: number; selection: DiscoverSelection }> = [
  { active: 0, selection: {} },
  { active: 1, selection: { terms: { tag: { include: ['bench-tag-1'], exclude: [] } } } },
  {
    active: 3,
    selection: {
      terms: {
        tag: { include: ['bench-tag-1', 'bench-tag-2'], exclude: [] },
        genre: { include: ['bench-genre-1', 'bench-genre-2'], exclude: [] },
        readStatus: { include: ['unread'], exclude: [] },
      },
    },
  },
  {
    active: 6,
    selection: {
      terms: {
        tag: { include: ['bench-tag-1'], exclude: ['bench-tag-3'] },
        genre: { include: ['bench-genre-1', 'bench-genre-2'], exclude: [] },
        readStatus: { include: ['unread'], exclude: [] },
        language: { include: [], exclude: ['fr'] },
        format: { include: ['epub', 'pdf'], exclude: [] },
      },
      ranges: { publishedYear: { min: 1990 } },
    },
  },
];

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

describe.skipIf(!BOOKS)('Discover facets benchmark (e2e, opt-in)', { timeout: 3_600_000 }, () => {
  let ctx!: MetadataWriteE2EContext;
  let libraryId!: number;

  beforeAll(async () => {
    ctx = await createMetadataWriteE2EContext();
    const library = await createLibraryWithFolder(ctx, { name: `discover-bench-${BOOKS}` });
    libraryId = library.libraryId;
    const [admin] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.username, 'metadata-write-e2e-admin')).limit(1);
    const lib = libraryId;
    const folder = library.libraryFolderId;
    const authorCount = Math.max(1, Math.floor(BOOKS / 4));
    const seriesCount = Math.max(1, Math.floor(BOOKS / 10));
    const started = Date.now();

    const statements: SQL[] = [
      sql`SELECT setseed(0.42)`,
      sql`INSERT INTO tags (name) SELECT 'bench-tag-' || g FROM generate_series(1, ${TAGS}::int) g ON CONFLICT DO NOTHING`,
      sql`INSERT INTO genres (name) SELECT 'bench-genre-' || g FROM generate_series(1, ${GENRES}::int) g ON CONFLICT DO NOTHING`,
      sql`INSERT INTO authors (name, sort_name) SELECT 'Bench Author ' || g, 'Author, Bench ' || g FROM generate_series(1, ${authorCount}::int) g`,
      sql`INSERT INTO book_series (name, normalized_name) SELECT 'Bench Series ' || g, 'bench series ' || g || '-' || ${lib}::int FROM generate_series(1, ${seriesCount}::int) g`,
      sql`INSERT INTO books (library_id, library_folder_id, folder_path, status, added_at)
          SELECT ${lib}::int, ${folder}::int, '/bench/' || g, 'present', now() - (floor(random() * 1500) || ' days')::interval
          FROM generate_series(1, ${BOOKS}::int) g`,
      sql`INSERT INTO book_metadata (book_id, title, language, publisher, published_year, page_count)
          SELECT id, 'Bench Book ' || id,
            (ARRAY['en','en','en','en','ja','fr','de','es'])[1 + floor(random() * 8)::int],
            CASE WHEN random() < 0.9 THEN 'Publisher ' || (1 + floor(power(random(), 2) * 200)::int) END,
            CASE WHEN random() < 0.9 THEN 1950 + floor(random() * 76)::int END,
            CASE WHEN random() < 0.85 THEN 50 + floor(random() * 900)::int END
          FROM books WHERE library_id = ${lib}::int`,
      sql`INSERT INTO book_files (book_id, library_folder_id, absolute_path, rel_path, ino, format, role)
          SELECT id, ${folder}::int, '/bench/' || id || '/book', 'bench/' || id || '/book', 7000000 + id,
            (ARRAY['epub','epub','epub','pdf','cbz','m4b','mobi'])[1 + floor(random() * 7)::int], 'content'
          FROM books WHERE library_id = ${lib}::int`,
      sql`UPDATE books SET primary_file_id = f.id FROM book_files f WHERE f.book_id = books.id AND books.library_id = ${lib}::int`,
      // 8 to 16 tags per book, skewed so a few tags are on many books and most on few.
      sql`INSERT INTO book_tags (book_id, tag_id)
          SELECT b.id, t.id FROM books b
          CROSS JOIN LATERAL (SELECT 1 + floor(power(random(), 2.5) * ${TAGS}::int)::int AS n FROM generate_series(1, 8 + b.id % 9)) pick
          JOIN tags t ON t.name = 'bench-tag-' || pick.n
          WHERE b.library_id = ${lib}::int ON CONFLICT DO NOTHING`,
      sql`INSERT INTO book_genres (book_id, genre_id)
          SELECT b.id, g.id FROM books b
          CROSS JOIN LATERAL (SELECT 1 + floor(power(random(), 1.5) * ${GENRES}::int)::int AS n FROM generate_series(1, 1 + b.id % 3)) pick
          JOIN genres g ON g.name = 'bench-genre-' || pick.n
          WHERE b.library_id = ${lib}::int ON CONFLICT DO NOTHING`,
      sql`INSERT INTO book_authors (book_id, author_id, display_order)
          SELECT b.id, a.id, pick.i - 1 FROM books b
          CROSS JOIN LATERAL (SELECT i, 1 + floor(random() * ${authorCount}::int)::int AS n FROM generate_series(1, 1 + (b.id % 7 = 0)::int) i) pick
          JOIN authors a ON a.name = 'Bench Author ' || pick.n
          WHERE b.library_id = ${lib}::int ON CONFLICT DO NOTHING`,
      sql`INSERT INTO book_series_memberships (book_id, series_id, series_index, display_order)
          SELECT b.id, s.id, ((b.id % 20) + 1)::text, 0 FROM books b
          JOIN book_series s ON s.normalized_name = 'bench series ' || (1 + (b.id * 7919) % ${seriesCount}::int) || '-' || ${lib}::int
          WHERE b.library_id = ${lib}::int AND b.id % 10 < 6`,
      sql`INSERT INTO user_book_status (user_id, book_id, status, source)
          SELECT ${admin!.id}::int, id, (ARRAY['read','reading','want_to_read','on_hold'])[1 + floor(random() * 4)::int], 'manual'
          FROM books WHERE library_id = ${lib}::int AND random() < 0.3`,
      sql`INSERT INTO user_book_ratings (user_id, book_id, rating)
          SELECT ${admin!.id}::int, id, 1 + floor(random() * 5)::int FROM books WHERE library_id = ${lib}::int AND random() < 0.2`,
      sql`ANALYZE`,
    ];
    for (const statement of statements) await ctx.db.execute(statement);
    const [{ links }] = (
      await ctx.db.execute<{ links: number }>(
        sql`SELECT count(*)::int AS links FROM book_tags bt JOIN books b ON b.id = bt.book_id WHERE b.library_id = ${lib}::int`,
      )
    ).rows as [{ links: number }];
    console.log(`[bench] seeded books=${BOOKS} bookTags=${links} seedMs=${Date.now() - started}`);
  }, 1_800_000);

  afterAll(async () => {
    if (ctx) await closeMetadataWriteE2EContext(ctx);
  });

  async function timeRequest(body: DiscoverFacetsRequest): Promise<number> {
    const started = performance.now();
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/libraries/${libraryId}/discover/facets`,
      headers: authHeader(ctx.adminToken),
      payload: body as object,
    });
    const elapsed = performance.now() - started;
    expect(response.statusCode, response.body).toBe(201);
    return elapsed;
  }

  /** Runs one request with db.execute captured, then EXPLAIN ANALYZEs each captured facet query. */
  async function explainRequest(body: DiscoverFacetsRequest): Promise<number[]> {
    const captured: SQL[] = [];
    const original = ctx.db.execute.bind(ctx.db);
    const spy = vi.spyOn(ctx.db, 'execute').mockImplementation(((query: SQL) => {
      captured.push(query);
      return original(query);
    }) as never);
    try {
      await timeRequest(body);
    } finally {
      spy.mockRestore();
    }
    const times: number[] = [];
    for (const query of captured) {
      const result = await ctx.db.execute<{ 'QUERY PLAN': Array<{ 'Execution Time': number }> }>(
        sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
      );
      const executionMs = result.rows[0]!['QUERY PLAN'][0]!['Execution Time'];
      times.push(executionMs);
      if (process.env.DISCOVER_BENCH_PLAN && executionMs > Number(process.env.DISCOVER_BENCH_PLAN)) {
        const text = await ctx.db.execute<{ 'QUERY PLAN': string }>(sql`EXPLAIN (ANALYZE, COSTS OFF) ${query}`);
        console.log(
          `[bench] slow query ${executionMs.toFixed(0)} ms\n${dialect.sqlToQuery(query).sql}\n${text.rows.map((row) => row['QUERY PLAN']).join('\n')}`,
        );
      }
    }
    return times.sort((a, b) => b - a);
  }

  it('records request latency and per-query execution time', async () => {
    const rows: string[] = [
      '| Active facets | Facets requested | p50 ms | p95 ms | Max ms | Slowest facet queries (EXPLAIN ANALYZE ms) |',
      '| --- | --- | --- | --- | --- | --- |',
    ];
    for (const { active, selection } of SELECTIONS) {
      for (const [label, keys] of [
        ['3 (default panels)', DEFAULT_FACETS],
        ['12 (all)', ALL_FACETS],
      ] as const) {
        const body: DiscoverFacetsRequest = { selection, facets: keys.map((key) => ({ key })) };
        await timeRequest(body);
        await timeRequest(body);
        const samples: number[] = [];
        for (let run = 0; run < RUNS; run += 1) samples.push(await timeRequest(body));
        samples.sort((a, b) => a - b);
        const explain = await explainRequest(body);
        rows.push(
          `| ${active} | ${label} | ${percentile(samples, 50).toFixed(0)} | ${percentile(samples, 95).toFixed(0)} | ${samples.at(-1)!.toFixed(0)} | ${explain
            .slice(0, 3)
            .map((ms) => ms.toFixed(1))
            .join(', ')} |`,
        );
      }
    }
    console.log(`[bench] books=${BOOKS} runs=${RUNS}\n${rows.join('\n')}`);
  });
});
