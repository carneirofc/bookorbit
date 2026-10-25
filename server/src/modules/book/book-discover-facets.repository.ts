import { Inject, Injectable } from '@nestjs/common';
import { SQL, eq, sql } from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { DiscoverFacetSort } from '@bookorbit/types';
import { accentInsensitiveIlike, buildSearchPattern } from '../../common/utils/accent-insensitive-search.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { authors, bookAuthors, bookGenres, bookMetadata, bookSeries, bookSeriesMemberships, books, bookTags, genres, tags } from '../../db/schema';
import { visibleBooksWhere } from './book.repository';

type Db = NodePgDatabase<typeof schema>;

export type DiscoverRelation = 'tag' | 'genre' | 'author' | 'series';
export type DiscoverMetadataColumn = 'language' | 'publisher';
export type DiscoverRangeField = 'publishedYear' | 'pageCount' | 'addedAt';

export type DiscoverValueCount = { value: string; label: string; count: number };

type RelationSql = {
  link: AnyPgTable;
  linkBookId: AnyPgColumn;
  linkEntityId: AnyPgColumn;
  entity: AnyPgTable;
  entityId: AnyPgColumn;
  name: AnyPgColumn;
  /** The facet value: the name, except for authors, which are matched by id. */
  value: SQL;
  /** Columns that make one facet row. Series names are not unique, and the series filter matches by name. */
  groupBy: SQL;
  /** Books are linked to a tag, genre or author at most once (primary key), but may sit in two same-named series. */
  count: SQL;
};

const RELATIONS: Record<DiscoverRelation, RelationSql> = {
  tag: {
    link: bookTags,
    linkBookId: bookTags.bookId,
    linkEntityId: bookTags.tagId,
    entity: tags,
    entityId: tags.id,
    name: tags.name,
    value: sql`${tags.name}`,
    groupBy: sql`${tags.name}`,
    count: sql`count(${bookTags.bookId})::int`,
  },
  genre: {
    link: bookGenres,
    linkBookId: bookGenres.bookId,
    linkEntityId: bookGenres.genreId,
    entity: genres,
    entityId: genres.id,
    name: genres.name,
    value: sql`${genres.name}`,
    groupBy: sql`${genres.name}`,
    count: sql`count(${bookGenres.bookId})::int`,
  },
  author: {
    link: bookAuthors,
    linkBookId: bookAuthors.bookId,
    linkEntityId: bookAuthors.authorId,
    entity: authors,
    entityId: authors.id,
    name: authors.name,
    value: sql`${authors.id}::text`,
    groupBy: sql`${authors.id}, ${authors.name}`,
    count: sql`count(${bookAuthors.bookId})::int`,
  },
  series: {
    link: bookSeriesMemberships,
    linkBookId: bookSeriesMemberships.bookId,
    linkEntityId: bookSeriesMemberships.seriesId,
    entity: bookSeries,
    entityId: bookSeries.id,
    name: bookSeries.name,
    value: sql`${bookSeries.name}`,
    groupBy: sql`${bookSeries.name}`,
    count: sql`count(DISTINCT ${bookSeriesMemberships.bookId})::int`,
  },
};

const METADATA_COLUMNS: Record<DiscoverMetadataColumn, AnyPgColumn> = {
  language: bookMetadata.language,
  publisher: bookMetadata.publisher,
};

const RANGE_COLUMNS: Record<DiscoverRangeField, AnyPgColumn> = {
  publishedYear: bookMetadata.publishedYear,
  pageCount: bookMetadata.pageCount,
  addedAt: books.addedAt,
};

function joinValues(values: readonly (string | number)[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

function orderBySql(sort: DiscoverFacetSort): SQL {
  return sort === 'alpha' ? sql`label ASC, value ASC` : sql`book_count DESC, label ASC, value ASC`;
}

function toValueCounts(rows: Array<{ value: string; label: string; book_count: number | string }>): DiscoverValueCount[] {
  return rows.map((row) => ({ value: String(row.value), label: row.label, count: Number(row.book_count) }));
}

export type DiscoverRangeSummary = { min: number | null; max: number | null; noneCount: number };

/**
 * Discover facet counts over the books matching a `BookQueryBuilder.buildWhere` clause. Every
 * query reads the matched set from `books` joined to `book_metadata` (the join set `countWhere`
 * uses, which every filter rule is written against) and drops processing books, so a count here
 * equals the listing total for the same filter.
 *
 * Joins added for the facet itself are aliased, so a rule's correlated subquery inside `where`
 * keeps binding to its own rows.
 */
@Injectable()
export class BookDiscoverFacetsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  private matchedBookIds(where: SQL | undefined) {
    return this.db.select({ id: books.id }).from(books).leftJoin(bookMetadata, eq(bookMetadata.bookId, books.id)).where(visibleBooksWhere(where));
  }

  /** Top values of a relation facet, leaving out `excludeValues`. One extra row tells the caller the list was cut. */
  async findRelationValues(opts: {
    relation: DiscoverRelation;
    where: SQL | undefined;
    search?: string;
    sort: DiscoverFacetSort;
    limit: number;
    excludeValues: string[];
  }): Promise<{ values: DiscoverValueCount[]; truncated: boolean }> {
    const r = RELATIONS[opts.relation];
    const predicates: SQL[] = [];
    const search = opts.search?.trim();
    if (search) predicates.push(accentInsensitiveIlike(r.name, buildSearchPattern(search)));
    if (opts.excludeValues.length > 0) predicates.push(sql`${r.value} NOT IN (${joinValues(opts.excludeValues)})`);
    const where = predicates.length > 0 ? sql`WHERE ${sql.join(predicates, sql` AND `)}` : sql``;
    const matchedLinks = sql`${r.linkBookId} IN (${this.matchedBookIds(opts.where)})`;

    // The matched books' links are counted first, in a subquery Postgres cannot flatten (GROUP BY,
    // or OFFSET 0 for series). Flattened, it underestimates the matched set and drives the join
    // from every row of the entity table, probing each matched book once per tag. Series are
    // counted by name, and one book can sit in two same-named series, so they count distinct books.
    const source =
      opts.relation === 'series'
        ? sql`
          SELECT ${r.value} AS value, ${r.name} AS label, count(DISTINCT pairs.book_id)::int AS book_count
          FROM (SELECT ${r.linkEntityId} AS entity_id, ${r.linkBookId} AS book_id FROM ${r.link} WHERE ${matchedLinks} OFFSET 0) pairs
          INNER JOIN ${r.entity} ON ${r.entityId} = pairs.entity_id
          ${where}
          GROUP BY ${r.groupBy}`
        : sql`
          SELECT ${r.value} AS value, ${r.name} AS label, link_counts.book_count AS book_count
          FROM (SELECT ${r.linkEntityId} AS entity_id, count(*)::int AS book_count FROM ${r.link} WHERE ${matchedLinks} GROUP BY ${r.linkEntityId}) link_counts
          INNER JOIN ${r.entity} ON ${r.entityId} = link_counts.entity_id
          ${where}`;

    const result = await this.db.execute<{ value: string; label: string; book_count: number }>(sql`
      ${source}
      ORDER BY ${orderBySql(opts.sort)}
      LIMIT ${opts.limit + 1}
    `);
    const values = toValueCounts(result.rows);
    const truncated = values.length > opts.limit;
    return { values: truncated ? values.slice(0, opts.limit) : values, truncated };
  }

  /** Counts for named values; values that no longer exist are simply absent. */
  async countRelationValues(opts: { relation: DiscoverRelation; where: SQL | undefined; values: string[] }): Promise<DiscoverValueCount[]> {
    if (opts.values.length === 0) return [];
    const r = RELATIONS[opts.relation];
    const values = opts.relation === 'author' ? opts.values.map(Number) : opts.values;
    const result = await this.db.execute<{ value: string; label: string; book_count: number }>(sql`
      SELECT ${r.value} AS value, min(${r.name}) AS label, ${r.count} AS book_count
      FROM ${r.entity}
      LEFT JOIN ${r.link} ON ${r.linkEntityId} = ${r.entityId} AND ${r.linkBookId} IN (${this.matchedBookIds(opts.where)})
      WHERE ${opts.relation === 'author' ? r.entityId : r.name} IN (${joinValues(values)})
      GROUP BY ${r.groupBy}
    `);
    return toValueCounts(result.rows);
  }

  /** Top non-empty values of a `book_metadata` text column. */
  async findMetadataValues(opts: {
    column: DiscoverMetadataColumn;
    where: SQL | undefined;
    search?: string;
    sort: DiscoverFacetSort;
    limit: number;
    excludeValues: string[];
  }): Promise<{ values: DiscoverValueCount[]; truncated: boolean }> {
    const column = METADATA_COLUMNS[opts.column];
    const predicates: SQL[] = [visibleBooksWhere(opts.where), sql`${column} IS NOT NULL`, sql`${column} <> ''`];
    const search = opts.search?.trim();
    if (search) predicates.push(accentInsensitiveIlike(column, buildSearchPattern(search)));
    if (opts.excludeValues.length > 0) predicates.push(sql`${column} NOT IN (${joinValues(opts.excludeValues)})`);

    const result = await this.db.execute<{ value: string; label: string; book_count: number }>(sql`
      SELECT ${column} AS value, ${column} AS label, count(*)::int AS book_count
      FROM ${books}
      LEFT JOIN ${bookMetadata} ON ${bookMetadata.bookId} = ${books.id}
      WHERE ${sql.join(predicates, sql` AND `)}
      GROUP BY ${column}
      ORDER BY ${orderBySql(opts.sort)}
      LIMIT ${opts.limit + 1}
    `);
    const values = toValueCounts(result.rows);
    const truncated = values.length > opts.limit;
    return { values: truncated ? values.slice(0, opts.limit) : values, truncated };
  }

  async countMetadataValues(opts: { column: DiscoverMetadataColumn; where: SQL | undefined; values: string[] }): Promise<DiscoverValueCount[]> {
    if (opts.values.length === 0) return [];
    const column = METADATA_COLUMNS[opts.column];
    const result = await this.db.execute<{ value: string; label: string; book_count: number }>(sql`
      SELECT ${column} AS value, ${column} AS label, count(*)::int AS book_count
      FROM ${books}
      LEFT JOIN ${bookMetadata} ON ${bookMetadata.bookId} = ${books.id}
      WHERE ${visibleBooksWhere(opts.where)} AND ${column} IN (${joinValues(opts.values)})
      GROUP BY ${column}
    `);
    return toValueCounts(result.rows);
  }

  /** The user's read status per book, where a book with no status row reads as `unread`, as the filter does. */
  async countReadStatuses(where: SQL | undefined, userId: number): Promise<Array<{ value: string; count: number }>> {
    const result = await this.db.execute<{ value: string; book_count: number }>(sql`
      SELECT coalesce(facet_status.status, 'unread') AS value, count(*)::int AS book_count
      FROM ${books}
      LEFT JOIN ${bookMetadata} ON ${bookMetadata.bookId} = ${books.id}
      LEFT JOIN user_book_status AS facet_status ON facet_status.book_id = ${books.id} AND facet_status.user_id = ${userId}
      WHERE ${visibleBooksWhere(where)}
      GROUP BY 1
    `);
    return result.rows.map((row) => ({ value: row.value, count: Number(row.book_count) }));
  }

  /** The user's own rating per book; `null` collects the unrated books. */
  async countUserRatings(where: SQL | undefined, userId: number): Promise<Array<{ rating: number | null; count: number }>> {
    const result = await this.db.execute<{ rating: number | null; book_count: number }>(sql`
      SELECT facet_rating.rating AS rating, count(*)::int AS book_count
      FROM ${books}
      LEFT JOIN ${bookMetadata} ON ${bookMetadata.bookId} = ${books.id}
      LEFT JOIN user_book_ratings AS facet_rating ON facet_rating.book_id = ${books.id} AND facet_rating.user_id = ${userId}
      WHERE ${visibleBooksWhere(where)}
      GROUP BY 1
    `);
    return result.rows.map((row) => ({ rating: row.rating === null ? null : Number(row.rating), count: Number(row.book_count) }));
  }

  /**
   * Smallest and largest value, and how many matched books have none. `addedAt` is read as a UTC
   * month index (`year * 12 + month - 1`), the unit its buckets use.
   */
  async findRangeSummary(field: DiscoverRangeField, where: SQL | undefined): Promise<DiscoverRangeSummary> {
    const value = this.rangeValueSql(field);
    const result = await this.db.execute<{ min: number | string | null; max: number | string | null; none_count: number }>(sql`
      SELECT min(${value}) AS min, max(${value}) AS max, count(*) FILTER (WHERE ${value} IS NULL)::int AS none_count
      FROM ${books}
      LEFT JOIN ${bookMetadata} ON ${bookMetadata.bookId} = ${books.id}
      WHERE ${visibleBooksWhere(where)}
    `);
    const row = result.rows[0];
    return {
      min: row?.min === null || row?.min === undefined ? null : Number(row.min),
      max: row?.max === null || row?.max === undefined ? null : Number(row.max),
      noneCount: Number(row?.none_count ?? 0),
    };
  }

  /** Book counts per equal-width bucket starting at `min`; empty buckets are absent. */
  async countRangeBuckets(
    field: DiscoverRangeField,
    where: SQL | undefined,
    min: number,
    width: number,
  ): Promise<Array<{ bucket: number; count: number }>> {
    const value = this.rangeValueSql(field);
    const result = await this.db.execute<{ bucket: number; book_count: number }>(sql`
      SELECT ((${value} - ${min}::int) / ${width}::int)::int AS bucket, count(*)::int AS book_count
      FROM ${books}
      LEFT JOIN ${bookMetadata} ON ${bookMetadata.bookId} = ${books.id}
      WHERE ${visibleBooksWhere(where)} AND ${value} IS NOT NULL
      GROUP BY 1
    `);
    return result.rows.map((row) => ({ bucket: Number(row.bucket), count: Number(row.book_count) }));
  }

  private rangeValueSql(field: DiscoverRangeField): SQL {
    const column = RANGE_COLUMNS[field];
    if (field !== 'addedAt') return sql`${column}`;
    return sql`(extract(year FROM ${column} AT TIME ZONE 'UTC')::int * 12 + extract(month FROM ${column} AT TIME ZONE 'UTC')::int - 1)`;
  }
}
