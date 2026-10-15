import type { GroupRule, Rule } from '@bookorbit/types'

/** The server caps list values per rule; a longer list is split across an OR group. */
export const MAX_RULE_VALUES = 20

export type TagMatchMode = 'any' | 'all'

export interface TagPanelSelection {
  selected: string[]
  match: TagMatchMode
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size))
  return chunks
}

/** Narrows to books carrying the panel's tags: any of them, or all of them. Null when nothing is picked. */
export function panelRule(panel: TagPanelSelection): Rule | null {
  if (panel.selected.length === 0) return null
  return {
    type: 'rule',
    field: 'tag',
    operator: panel.match === 'all' ? 'includesAll' : 'includesAny',
    value: panel.selected.slice(0, MAX_RULE_VALUES),
  }
}

/** Drops books carrying any of the excluded tags. Long lists become several rules, since all must hold anyway. */
export function excludedTagRules(names: string[]): Rule[] {
  return chunk(names, MAX_RULE_VALUES).map((values) => ({ type: 'rule', field: 'tag', operator: 'excludesAll', value: values }))
}

/**
 * Restricts results to the chosen libraries. Every library chosen needs no rule at all, and when
 * most are chosen it is shorter to exclude the rest. Null means "no restriction".
 */
export function libraryRule(selectedNames: string[], allNames: string[]): Rule | GroupRule | null {
  const selected = new Set(selectedNames)
  if (allNames.every((name) => selected.has(name))) return null
  const excluded = allNames.filter((name) => !selected.has(name))
  if (excluded.length < selectedNames.length && excluded.length <= MAX_RULE_VALUES) {
    return { type: 'rule', field: 'library', operator: 'excludesAll', value: excluded }
  }
  const rules: Rule[] = chunk(selectedNames, MAX_RULE_VALUES).map((names) => ({
    type: 'rule',
    field: 'library',
    operator: 'includesAny',
    value: names,
  }))
  return rules.length === 1 ? rules[0]! : { type: 'group', join: 'OR', rules }
}

/**
 * ANDs the pieces into one filter tree. An AND-joined extra filter is flattened into the root so
 * the tree stays as shallow as the filter builder made it; the server bounds nesting depth.
 */
export function combineFilters(parts: Array<Rule | GroupRule | null | undefined>, extra?: GroupRule): GroupRule | undefined {
  const rules: Array<Rule | GroupRule> = parts.filter((part): part is Rule | GroupRule => part != null)
  if (extra && extra.rules.length > 0) {
    if (extra.join === 'AND') rules.push(...extra.rules)
    else rules.push(extra)
  }
  return rules.length > 0 ? { type: 'group', join: 'AND', rules } : undefined
}

/** Tags already picked in the panels before `index`, so later panels do not offer them again. */
export function tagsSelectedBefore(panels: TagPanelSelection[], index: number): string[] {
  const names = new Set<string>()
  for (const panel of panels.slice(0, index)) {
    for (const name of panel.selected) names.add(name)
  }
  return [...names]
}

/** Adds rules to an AND filter without nesting it a level deeper, since the server bounds depth. */
export function narrowFilter(filter: GroupRule | undefined, ...rules: Rule[]): GroupRule {
  if (filter && filter.join === 'AND') return { ...filter, rules: [...filter.rules, ...rules] }
  return { type: 'group', join: 'AND', rules: filter ? [filter, ...rules] : rules }
}

export function hasTagRule(name: string): Rule {
  return { type: 'rule', field: 'tag', operator: 'includesAny', value: [name] }
}
