import { describe, expect, it } from 'vitest'
import type { GroupRule } from '@bookorbit/types'
import { combineFilters, excludedTagRules, libraryRule, narrowFilter, panelRule, tagsSelectedBefore } from '../tag-browser-filter'

describe('panelRule', () => {
  it('returns null when nothing is selected', () => {
    expect(panelRule({ selected: [], match: 'any' })).toBeNull()
  })

  it('matches any or all of the selected tags', () => {
    expect(panelRule({ selected: ['fantasy', 'magic'], match: 'any' })).toEqual({
      type: 'rule',
      field: 'tag',
      operator: 'includesAny',
      value: ['fantasy', 'magic'],
    })
    expect(panelRule({ selected: ['fantasy'], match: 'all' })).toMatchObject({ operator: 'includesAll' })
  })
})

describe('libraryRule', () => {
  const all = ['Fiction', 'Comics', 'Manga']

  it('adds no restriction when every library is selected', () => {
    expect(libraryRule(all, all)).toBeNull()
  })

  it('excludes the minority when most libraries are selected', () => {
    expect(libraryRule(['Fiction', 'Comics'], all)).toEqual({ type: 'rule', field: 'library', operator: 'excludesAll', value: ['Manga'] })
  })

  it('includes the selection when it is the smaller side', () => {
    expect(libraryRule(['Fiction'], all)).toEqual({ type: 'rule', field: 'library', operator: 'includesAny', value: ['Fiction'] })
  })

  it('splits long inclusion lists into an OR group within the per-rule value cap', () => {
    const names = Array.from({ length: 50 }, (_, i) => `Library ${i}`)
    const rule = libraryRule(names.slice(0, 25), names) as GroupRule
    expect(rule.type).toBe('group')
    expect(rule.join).toBe('OR')
    expect(rule.rules).toHaveLength(2)
  })
})

describe('combineFilters', () => {
  it('returns undefined when there is nothing to filter on', () => {
    expect(combineFilters([null, undefined])).toBeUndefined()
  })

  it('flattens an AND extra filter into the root', () => {
    const extra: GroupRule = { type: 'group', join: 'AND', rules: [{ type: 'rule', field: 'rating', operator: 'gte', value: 4 }] }
    const result = combineFilters([panelRule({ selected: ['fantasy'], match: 'any' })], extra)
    expect(result?.rules).toHaveLength(2)
    expect(result?.rules[1]).toEqual(extra.rules[0])
  })

  it('nests an OR extra filter as its own group', () => {
    const extra: GroupRule = {
      type: 'group',
      join: 'OR',
      rules: [
        { type: 'rule', field: 'language', operator: 'eq', value: 'en' },
        { type: 'rule', field: 'language', operator: 'eq', value: 'pt' },
      ],
    }
    expect(combineFilters([], extra)?.rules).toEqual([extra])
  })
})

describe('tagsSelectedBefore', () => {
  it('collects the distinct tags picked in earlier panels only', () => {
    const panels = [
      { selected: ['fantasy', 'magic'], match: 'any' as const },
      { selected: ['magic', 'dragons'], match: 'any' as const },
      { selected: ['epic'], match: 'any' as const },
    ]
    expect(tagsSelectedBefore(panels, 0)).toEqual([])
    expect(tagsSelectedBefore(panels, 2)).toEqual(['fantasy', 'magic', 'dragons'])
  })
})

describe('excludedTagRules', () => {
  it('returns no rules when nothing is excluded', () => {
    expect(excludedTagRules([])).toEqual([])
  })

  it('splits long exclusion lists into several excludesAll rules', () => {
    const names = Array.from({ length: 25 }, (_, i) => `tag-${i}`)
    const rules = excludedTagRules(names)
    expect(rules).toHaveLength(2)
    expect(rules.every((rule) => rule.operator === 'excludesAll')).toBe(true)
    expect(rules.flatMap((rule) => rule.value as string[])).toEqual(names)
  })
})

describe('narrowFilter', () => {
  const tagRule = { type: 'rule' as const, field: 'tag' as const, operator: 'includesAny' as const, value: ['fantasy'] }

  it('appends to an AND filter without nesting it', () => {
    const filter: GroupRule = { type: 'group', join: 'AND', rules: [{ type: 'rule', field: 'rating', operator: 'gte', value: 4 }] }
    expect(narrowFilter(filter, tagRule)).toEqual({ type: 'group', join: 'AND', rules: [filter.rules[0], tagRule] })
  })

  it('wraps an OR filter and builds a root when there is none', () => {
    const filter: GroupRule = { type: 'group', join: 'OR', rules: [tagRule] }
    expect(narrowFilter(filter, tagRule).rules).toEqual([filter, tagRule])
    expect(narrowFilter(undefined, tagRule)).toEqual({ type: 'group', join: 'AND', rules: [tagRule] })
  })
})
