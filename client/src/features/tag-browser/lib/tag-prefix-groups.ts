import type { TagFacet } from '@bookorbit/types'

/** Separators that commonly namespace tags, as in "genre: fantasy", "Fiction/Epic" or "Mood > Dark". */
const PREFIX_SEPARATOR = /\s*(?::|\/|>)\s*/

export interface PrefixedTag {
  facet: TagFacet
  /** The name with the group prefix removed, for display inside its group. */
  label: string
}

export interface TagPrefixGroup {
  prefix: string
  tags: PrefixedTag[]
  /** Sum of the member counts. A book carrying two members counts twice, so this ranks groups rather than counting books. */
  tagCountSum: number
}

export interface GroupedTags {
  groups: TagPrefixGroup[]
  ungrouped: TagFacet[]
}

function splitPrefix(name: string): { prefix: string; label: string } | null {
  const match = PREFIX_SEPARATOR.exec(name)
  if (!match || match.index === 0) return null
  const prefix = name.slice(0, match.index).trim()
  const label = name.slice(match.index + match[0].length).trim()
  return prefix && label ? { prefix, label } : null
}

/**
 * Groups tags by the text before their first namespace separator. Prefixes are compared case
 * insensitively and only become a group once two tags share them; a lone prefixed tag stays in
 * the flat list under its full name. Groups keep the order of their first member.
 */
export function groupTagsByPrefix(facets: TagFacet[]): GroupedTags {
  const byPrefix = new Map<string, TagPrefixGroup>()
  const order: string[] = []
  for (const facet of facets) {
    const split = splitPrefix(facet.name)
    if (!split) continue
    const key = split.prefix.toLocaleLowerCase()
    let group = byPrefix.get(key)
    if (!group) {
      group = { prefix: split.prefix, tags: [], tagCountSum: 0 }
      byPrefix.set(key, group)
      order.push(key)
    }
    group.tags.push({ facet, label: split.label })
    group.tagCountSum += facet.count
  }

  const groups: TagPrefixGroup[] = []
  const grouped = new Set<number>()
  for (const key of order) {
    const group = byPrefix.get(key)!
    if (group.tags.length < 2) continue
    groups.push(group)
    for (const member of group.tags) grouped.add(member.facet.id)
  }
  return { groups, ungrouped: facets.filter((facet) => !grouped.has(facet.id)) }
}
