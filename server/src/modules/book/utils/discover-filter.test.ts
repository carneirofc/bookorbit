import { compileDiscoverFilter, type DiscoverSelection, type GroupRule, type Rule } from '@bookorbit/types';

import { validateGroupRule } from './group-rule.validator';

function names(count: number, prefix = 'v'): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

function depth(node: GroupRule | Rule): number {
  return node.type === 'rule' ? 0 : 1 + Math.max(...node.rules.map(depth));
}

function compileValid(selection: DiscoverSelection, options?: Parameters<typeof compileDiscoverFilter>[1]): GroupRule | undefined {
  const filter = compileDiscoverFilter(selection, options);
  if (filter) {
    expect(validateGroupRule(filter)).toEqual(filter);
    expect(depth(filter)).toBeLessThanOrEqual(5);
  }
  return filter;
}

describe('compileDiscoverFilter', () => {
  it('returns undefined when nothing is selected', () => {
    expect(compileValid({})).toBeUndefined();
    expect(compileValid({ terms: { tag: { include: [], exclude: [] } }, ranges: { pageCount: {} } })).toBeUndefined();
  });

  it('compiles ALL tags, ANY genres and exclusions into one AND root', () => {
    expect(
      compileValid({
        terms: {
          tag: { include: ['Isekai', 'Reincarnation'], exclude: ['Harem'], mode: 'all' },
          genre: { include: ['Fantasy', 'Horror'], exclude: [] },
        },
      }),
    ).toEqual({
      type: 'group',
      join: 'AND',
      rules: [
        {
          type: 'group',
          join: 'AND',
          rules: [
            { type: 'rule', field: 'tag', operator: 'includesAll', value: ['Isekai', 'Reincarnation'] },
            { type: 'rule', field: 'tag', operator: 'excludesAll', value: ['Harem'] },
          ],
        },
        { type: 'rule', field: 'genre', operator: 'includesAny', value: ['Fantasy', 'Horror'] },
      ],
    });
  });

  it('defaults tags to ALL and genres and authors to ANY', () => {
    const filter = compileValid({
      terms: { tag: { include: ['a'], exclude: [] }, genre: { include: ['b'], exclude: [] }, authorId: { include: ['7'], exclude: [] } },
    });
    expect(filter?.rules).toEqual([
      { type: 'rule', field: 'tag', operator: 'includesAll', value: ['a'] },
      { type: 'rule', field: 'genre', operator: 'includesAny', value: ['b'] },
      { type: 'rule', field: 'authorId', operator: 'includesAny', value: [7] },
    ]);
  });

  it('ignores mode all on single-valued facets', () => {
    const filter = compileValid({ terms: { language: { include: ['en', 'ja'], exclude: [], mode: 'all' } } });
    expect(filter?.rules).toEqual([{ type: 'rule', field: 'language', operator: 'includesAny', value: ['en', 'ja'] }]);
  });

  it('ORs the none bucket with ANY includes and keeps excludeNone as isNotEmpty', () => {
    const filter = compileValid({
      terms: {
        genre: { include: ['Fantasy'], exclude: [], includeNone: true },
        series: { include: [], exclude: ['Dune'], excludeNone: true },
      },
    });
    expect(filter?.rules).toEqual([
      {
        type: 'group',
        join: 'OR',
        rules: [
          { type: 'rule', field: 'genre', operator: 'includesAny', value: ['Fantasy'] },
          { type: 'rule', field: 'genre', operator: 'isEmpty' },
        ],
      },
      {
        type: 'group',
        join: 'AND',
        rules: [
          { type: 'rule', field: 'series', operator: 'excludesAll', value: ['Dune'] },
          { type: 'rule', field: 'series', operator: 'isNotEmpty' },
        ],
      },
    ]);
  });

  it('compiles a lone includeNone to isEmpty', () => {
    expect(compileValid({ terms: { tag: { include: [], exclude: [], includeNone: true } } })?.rules).toEqual([
      { type: 'rule', field: 'tag', operator: 'isEmpty' },
    ]);
  });

  it('drops none flags on facets without a none bucket', () => {
    expect(compileValid({ terms: { format: { include: [], exclude: [], includeNone: true, excludeNone: true } } })).toBeUndefined();
  });

  it.each([21, 40, 100])('chunks %i ANY values into ORed rules of at most 20', (count) => {
    const filter = compileValid({ terms: { genre: { include: names(count), exclude: [] } } });
    const node = filter!.rules[0] as GroupRule;
    expect(node).toMatchObject({ type: 'group', join: 'OR' });
    expect(node.rules).toHaveLength(Math.ceil(count / 20));
    expect(node.rules.flatMap((rule) => (rule as Rule).value as string[])).toEqual(names(count));
  });

  it.each([21, 40, 100])('chunks %i ALL values and %i excludes into ANDed rules', (count) => {
    const filter = compileValid({ terms: { tag: { include: names(count), exclude: names(count, 'x'), mode: 'all', includeNone: true } } });
    const node = filter!.rules[0] as GroupRule;
    const [include, ...excludes] = node.rules as [GroupRule, ...Rule[]];
    expect(include).toMatchObject({ type: 'group', join: 'OR' });
    expect((include.rules[0] as GroupRule).rules.every((rule) => (rule as Rule).operator === 'includesAll')).toBe(true);
    expect(include.rules[1]).toEqual({ type: 'rule', field: 'tag', operator: 'isEmpty' });
    expect(excludes).toHaveLength(Math.ceil(count / 20));
    expect(excludes.every((rule) => rule.operator === 'excludesAll')).toBe(true);
  });

  it('compiles ratings to equality and exclusions to their complement', () => {
    const filter = compileValid({ terms: { rating: { include: ['4', '5'], exclude: ['1'], includeNone: true } } });
    expect(filter?.rules).toEqual([
      {
        type: 'group',
        join: 'AND',
        rules: [
          {
            type: 'group',
            join: 'OR',
            rules: [
              { type: 'rule', field: 'rating', operator: 'eq', value: 4 },
              { type: 'rule', field: 'rating', operator: 'eq', value: 5 },
              { type: 'rule', field: 'rating', operator: 'isEmpty' },
            ],
          },
          {
            type: 'group',
            join: 'OR',
            rules: [
              { type: 'rule', field: 'rating', operator: 'isEmpty' },
              { type: 'rule', field: 'rating', operator: 'eq', value: 2 },
              { type: 'rule', field: 'rating', operator: 'eq', value: 3 },
              { type: 'rule', field: 'rating', operator: 'eq', value: 4 },
              { type: 'rule', field: 'rating', operator: 'eq', value: 5 },
            ],
          },
        ],
      },
    ]);
  });

  it('compiles numeric ranges to between, gte and lte', () => {
    expect(compileValid({ ranges: { publishedYear: { min: 2015, max: 2020 } } })?.rules).toEqual([
      { type: 'rule', field: 'publishedYear', operator: 'between', value: 2015, valueTo: 2020 },
    ]);
    expect(compileValid({ ranges: { pageCount: { min: 100 } } })?.rules).toEqual([{ type: 'rule', field: 'pageCount', operator: 'gte', value: 100 }]);
    expect(compileValid({ ranges: { pageCount: { max: 400 } } })?.rules).toEqual([{ type: 'rule', field: 'pageCount', operator: 'lte', value: 400 }]);
  });

  it('compiles added-date ranges to whole inclusive UTC days', () => {
    expect(compileValid({ ranges: { addedAt: { min: '2024-03-01', max: '2024-03-31' } } })?.rules).toEqual([
      { type: 'rule', field: 'addedAt', operator: 'between', value: '2024-03-01T00:00:00.000Z', valueTo: '2024-03-31T23:59:59.999Z' },
    ]);
    expect(compileValid({ ranges: { addedAt: { min: '2024-03-01' } } })?.rules).toEqual([
      { type: 'rule', field: 'addedAt', operator: 'after', value: '2024-02-29T23:59:59.999Z' },
    ]);
    expect(compileValid({ ranges: { addedAt: { max: '2024-12-31' } } })?.rules).toEqual([
      { type: 'rule', field: 'addedAt', operator: 'before', value: '2025-01-01T00:00:00.000Z' },
    ]);
    expect(compileValid({ ranges: { addedAt: { withinLastDays: 30 } } })?.rules).toEqual([
      { type: 'rule', field: 'addedAt', operator: 'withinLast', value: 30 },
    ]);
  });

  describe('omitFacet', () => {
    const selection: DiscoverSelection = {
      terms: { genre: { include: ['Fantasy'], exclude: ['Horror'], includeNone: true }, tag: { include: ['a'], exclude: [] } },
      ranges: { publishedYear: { min: 2000 } },
    };

    it('drops only the includes of that facet with omitIncludesOnly', () => {
      expect(compileValid(selection, { omitFacet: 'genre', omitIncludesOnly: true })?.rules).toEqual([
        { type: 'rule', field: 'tag', operator: 'includesAll', value: ['a'] },
        { type: 'rule', field: 'genre', operator: 'excludesAll', value: ['Horror'] },
        { type: 'rule', field: 'publishedYear', operator: 'gte', value: 2000 },
      ]);
    });

    it('drops the whole facet without omitIncludesOnly', () => {
      expect(compileValid(selection, { omitFacet: 'genre' })?.rules).toEqual([
        { type: 'rule', field: 'tag', operator: 'includesAll', value: ['a'] },
        { type: 'rule', field: 'publishedYear', operator: 'gte', value: 2000 },
      ]);
      expect(compileValid(selection, { omitFacet: 'publishedYear' })?.rules).toHaveLength(2);
    });

    it('returns undefined when the omitted facet was the only one', () => {
      expect(compileValid({ terms: { tag: { include: ['a'], exclude: [] } } }, { omitFacet: 'tag', omitIncludesOnly: true })).toBeUndefined();
    });
  });

  it('keeps every combination within the validator limits', () => {
    const filter = compileValid({
      terms: {
        tag: { include: names(100), exclude: names(100, 'x'), mode: 'all', includeNone: true },
        genre: { include: names(100), exclude: names(100, 'y'), includeNone: true },
        authorId: { include: ['1', '2'], exclude: ['3'], mode: 'all', excludeNone: true },
        series: { include: names(30), exclude: [], includeNone: true },
        language: { include: ['en'], exclude: ['fr'] },
        format: { include: ['epub', 'pdf'], exclude: ['cbz'] },
        publisher: { include: [], exclude: ['Tor'], excludeNone: true },
        readStatus: { include: ['unread', 'reading'], exclude: ['read'] },
        rating: { include: ['5'], exclude: ['1', '2'], excludeNone: true },
      },
      ranges: { publishedYear: { min: 1990, max: 2000 }, pageCount: { max: 300 }, addedAt: { withinLastDays: 90 } },
    });
    expect(filter?.rules).toHaveLength(12);
  });
});
