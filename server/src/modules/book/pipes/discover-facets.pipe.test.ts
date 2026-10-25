import { BadRequestException } from '@nestjs/common';

import { DiscoverFacetsRequestPipe } from './discover-facets.pipe';

const pipe = new DiscoverFacetsRequestPipe();

function names(count: number, prefix = 'v'): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

describe('DiscoverFacetsRequestPipe', () => {
  it('fills defaults for an empty body', () => {
    expect(pipe.transform(undefined)).toEqual({ selection: {}, facets: [] });
    expect(pipe.transform({ selection: { terms: { tag: {} } } })).toEqual({
      selection: { terms: { tag: { include: [], exclude: [] } } },
      facets: [],
    });
  });

  it('accepts a full selection at the limits', () => {
    const body = {
      q: 'dragon',
      selection: {
        terms: {
          tag: { include: names(100), exclude: names(50, 'x'), mode: 'all', includeNone: true },
          genre: { include: ['Fantasy'], exclude: [], mode: 'any', excludeNone: true },
          authorId: { include: ['12', '2147483647'], exclude: [], mode: 'all' },
          rating: { include: ['5'], exclude: ['1'], includeNone: true },
          readStatus: { include: ['unread'], exclude: ['read'] },
          format: { include: ['epub', 'epub:readalong'], exclude: [] },
        },
        ranges: { publishedYear: { min: 1990, max: 2000 }, pageCount: { max: 400 }, addedAt: { min: '2024-01-01', max: '2024-01-31' } },
      },
      facets: [
        { key: 'tag', limit: 500, search: 'isek', sort: 'alpha' },
        { key: 'genre' },
        { key: 'authorId' },
        { key: 'series' },
        { key: 'language' },
        { key: 'format' },
        { key: 'publisher' },
        { key: 'readStatus' },
        { key: 'rating' },
        { key: 'publishedYear' },
        { key: 'pageCount' },
        { key: 'addedAt' },
      ],
    };
    expect(pipe.transform(body)).toEqual(body);
  });

  it.each([
    ['an unknown top-level field', { filter: {} }],
    ['an unknown term facet', { selection: { terms: { colour: { include: ['red'] } } } }],
    ['an unknown field on a term selection', { selection: { terms: { tag: { include: [], extra: true } } } }],
    ['an unknown range facet', { selection: { ranges: { rating: { min: 1 } } } }],
    ['withinLastDays on a numeric range', { selection: { ranges: { pageCount: { withinLastDays: 7 } } } }],
    ['mode all on language', { selection: { terms: { language: { include: ['en'], mode: 'all' } } } }],
    ['mode all on series', { selection: { terms: { series: { include: ['Dune'], mode: 'all' } } } }],
    ['a value both included and excluded', { selection: { terms: { genre: { include: ['Fantasy'], exclude: ['Fantasy'] } } } }],
    ['duplicate values', { selection: { terms: { genre: { include: ['Fantasy', 'Fantasy'] } } } }],
    ['an empty value', { selection: { terms: { genre: { include: [''] } } } }],
    ['more than 100 values per side', { selection: { terms: { genre: { include: names(101) } } } }],
    [
      'more than 200 values in total',
      { selection: { terms: { tag: { include: names(100), exclude: names(100, 'x') }, genre: { include: ['a'] } } } },
    ],
    ['a none bucket on format', { selection: { terms: { format: { includeNone: true } } } }],
    ['a none bucket on read status', { selection: { terms: { readStatus: { excludeNone: true } } } }],
    ['both none flags', { selection: { terms: { tag: { includeNone: true, excludeNone: true } } } }],
    ['a non-numeric author id', { selection: { terms: { authorId: { include: ['Ann'] } } } }],
    ['an author id beyond int4', { selection: { terms: { authorId: { include: ['2147483648'] } } } }],
    ['an unknown rating', { selection: { terms: { rating: { include: ['6'] } } } }],
    ['an unknown read status', { selection: { terms: { readStatus: { include: ['finished'] } } } }],
    ['an unknown format', { selection: { terms: { format: { include: ['doc'] } } } }],
    ['an inverted range', { selection: { ranges: { pageCount: { min: 400, max: 100 } } } }],
    ['a non-integer year', { selection: { ranges: { publishedYear: { min: 2000.5 } } } }],
    ['a malformed added date', { selection: { ranges: { addedAt: { min: '2024-13-01' } } } }],
    ['withinLastDays with a date', { selection: { ranges: { addedAt: { withinLastDays: 7, min: '2024-01-01' } } } }],
    ['an unknown facet key', { facets: [{ key: 'colour' }] }],
    ['duplicate facet keys', { facets: [{ key: 'tag' }, { key: 'tag', limit: 5 }] }],
    ['more than 12 facets', { facets: names(13).map(() => ({ key: 'tag' })) }],
    ['a facet limit above 500', { facets: [{ key: 'tag', limit: 501 }] }],
    ['a zero facet limit', { facets: [{ key: 'tag', limit: 0 }] }],
    ['a search longer than 200 characters', { facets: [{ key: 'tag', search: 'x'.repeat(201) }] }],
    ['a search on a range facet', { facets: [{ key: 'publishedYear', search: '19' }] }],
    ['a quick search longer than 200 characters', { q: 'x'.repeat(201) }],
  ])('rejects %s', (_name, body) => {
    expect(() => pipe.transform(body)).toThrow(BadRequestException);
  });
});
