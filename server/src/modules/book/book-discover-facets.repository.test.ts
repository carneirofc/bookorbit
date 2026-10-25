import { sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';

import * as schema from '../../db/schema';
import { BookDiscoverFacetsRepository } from './book-discover-facets.repository';

const dialect = new PgDialect();

function makeRepo(rows: Array<Record<string, unknown>> = []) {
  const db = drizzle.mock({ schema });
  const execute = vi.spyOn(db, 'execute').mockResolvedValue({ rows } as never);
  const repo = new BookDiscoverFacetsRepository(db as never);
  const lastQuery = () => {
    const query = dialect.sqlToQuery(execute.mock.calls.at(-1)![0] as SQL);
    return { sql: query.sql.replace(/\s+/g, ' ').trim(), params: query.params };
  };
  return { repo, execute, lastQuery };
}

const where = sql`"books"."library_id" = 3`;

describe('BookDiscoverFacetsRepository', () => {
  describe('findRelationValues', () => {
    it('aggregates the relation over the matched visible books and reads one row past the limit', async () => {
      const { repo, lastQuery } = makeRepo([
        { value: 'Magic', label: 'Magic', book_count: 4 },
        { value: 'Isekai', label: 'Isekai', book_count: '3' },
        { value: 'Space', label: 'Space', book_count: 1 },
      ]);

      const result = await repo.findRelationValues({ relation: 'tag', where, sort: 'count', limit: 2, excludeValues: ['Harem'], search: ' isek ' });

      expect(result).toEqual({
        values: [
          { value: 'Magic', label: 'Magic', count: 4 },
          { value: 'Isekai', label: 'Isekai', count: 3 },
        ],
        truncated: true,
      });
      const { sql: text, params } = lastQuery();
      expect(text).toContain('FROM "book_tags" INNER JOIN "tags" ON "tags"."id" = "book_tags"."tag_id"');
      expect(text).toContain('"book_tags"."book_id" IN (');
      expect(text).toContain(`"books"."status" <> $`);
      expect(text).toContain('"tags"."name" NOT IN (');
      expect(text).toContain('public.bookorbit_unaccent("tags"."name") ILIKE');
      expect(text).toContain('ORDER BY book_count DESC, label ASC, value ASC');
      expect(params).toEqual(expect.arrayContaining(['processing', 'Harem', '%isek%', 3]));
    });

    it('lists authors by id and series by name, counting each book once per series name', async () => {
      const { repo, lastQuery } = makeRepo();

      await repo.findRelationValues({ relation: 'author', where, sort: 'alpha', limit: 5, excludeValues: [] });
      const author = lastQuery().sql;
      await repo.findRelationValues({ relation: 'series', where, sort: 'alpha', limit: 5, excludeValues: [] });
      const series = lastQuery().sql;

      expect(author).toContain('"authors"."id"::text AS value');
      expect(author).toContain('GROUP BY "authors"."id", "authors"."name"');
      expect(author).toContain('ORDER BY label ASC, value ASC');
      expect(series).toContain('count(DISTINCT "book_series_memberships"."book_id")::int');
      expect(series).toContain('GROUP BY "book_series"."name"');
    });
  });

  describe('countRelationValues', () => {
    it('skips the query for no values', async () => {
      const { repo, execute } = makeRepo();
      await expect(repo.countRelationValues({ relation: 'tag', where, values: [] })).resolves.toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    });

    it('left-joins the matched books so a selected value with no books still counts zero', async () => {
      const { repo, lastQuery } = makeRepo([{ value: '12', label: 'Ann Leckie', book_count: 0 }]);

      const result = await repo.countRelationValues({ relation: 'author', where, values: ['12'] });

      expect(result).toEqual([{ value: '12', label: 'Ann Leckie', count: 0 }]);
      const { sql: text, params } = lastQuery();
      expect(text).toContain(
        'FROM "authors" LEFT JOIN "book_authors" ON "book_authors"."author_id" = "authors"."id" AND "book_authors"."book_id" IN (',
      );
      expect(text).toContain('WHERE "authors"."id" IN (');
      expect(params).toContain(12);
    });
  });

  describe('metadata facets', () => {
    it('lists non-empty values of the column', async () => {
      const { repo, lastQuery } = makeRepo([{ value: 'en', label: 'en', book_count: 7 }]);

      const result = await repo.findMetadataValues({ column: 'language', where, sort: 'count', limit: 30, excludeValues: ['fr'] });

      expect(result).toEqual({ values: [{ value: 'en', label: 'en', count: 7 }], truncated: false });
      const { sql: text } = lastQuery();
      expect(text).toContain('"book_metadata"."language" IS NOT NULL');
      expect(text).toContain(`"book_metadata"."language" <> ''`);
      expect(text).toContain('"book_metadata"."language" NOT IN (');
    });

    it('counts named values and skips the query for none', async () => {
      const { repo, execute, lastQuery } = makeRepo([{ value: 'Tor', label: 'Tor', book_count: 2 }]);

      await expect(repo.countMetadataValues({ column: 'publisher', where, values: [] })).resolves.toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      await expect(repo.countMetadataValues({ column: 'publisher', where, values: ['Tor'] })).resolves.toEqual([
        { value: 'Tor', label: 'Tor', count: 2 },
      ]);
      expect(lastQuery().sql).toContain('"book_metadata"."publisher" IN (');
    });
  });

  describe('per-user facets', () => {
    it('reads a missing status row as unread for the given user', async () => {
      const { repo, lastQuery } = makeRepo([{ value: 'unread', book_count: '5' }]);

      await expect(repo.countReadStatuses(where, 7)).resolves.toEqual([{ value: 'unread', count: 5 }]);
      const { sql: text, params } = lastQuery();
      expect(text).toContain(`coalesce(facet_status.status, 'unread')`);
      expect(text).toContain('LEFT JOIN user_book_status AS facet_status ON facet_status.book_id = "books"."id" AND facet_status.user_id = $');
      expect(params).toContain(7);
    });

    it('groups the user rating with unrated books under null', async () => {
      const { repo, lastQuery } = makeRepo([
        { rating: 5, book_count: 2 },
        { rating: null, book_count: 6 },
      ]);

      await expect(repo.countUserRatings(where, 7)).resolves.toEqual([
        { rating: 5, count: 2 },
        { rating: null, count: 6 },
      ]);
      expect(lastQuery().sql).toContain('LEFT JOIN user_book_ratings AS facet_rating');
    });
  });

  describe('ranges', () => {
    it('summarizes a numeric column', async () => {
      const { repo, lastQuery } = makeRepo([{ min: 1999, max: '2021', none_count: 1 }]);

      await expect(repo.findRangeSummary('publishedYear', where)).resolves.toEqual({ min: 1999, max: 2021, noneCount: 1 });
      expect(lastQuery().sql).toContain('min("book_metadata"."published_year")');
    });

    it('reports no bounds when nothing matched', async () => {
      const { repo } = makeRepo([{ min: null, max: null, none_count: 0 }]);
      await expect(repo.findRangeSummary('pageCount', where)).resolves.toEqual({ min: null, max: null, noneCount: 0 });
    });

    it('reads added dates as UTC month indexes', async () => {
      const { repo, lastQuery } = makeRepo([{ bucket: 2, book_count: 3 }]);

      await expect(repo.countRangeBuckets('addedAt', where, 24_289, 2)).resolves.toEqual([{ bucket: 2, count: 3 }]);
      const { sql: text, params } = lastQuery();
      expect(text).toContain(`extract(year FROM "books"."added_at" AT TIME ZONE 'UTC')::int * 12`);
      expect(text).toContain('IS NOT NULL');
      expect(params).toEqual(expect.arrayContaining([24_289, 2]));
    });
  });
});
