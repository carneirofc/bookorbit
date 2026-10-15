import { describe, expect, it } from 'vitest'
import type { TagFacet } from '@bookorbit/types'
import { groupTagsByPrefix } from '../tag-prefix-groups'

function facet(id: number, name: string, count = 1): TagFacet {
  return { id, name, count }
}

describe('groupTagsByPrefix', () => {
  it('groups tags that share a prefix across the supported separators', () => {
    const result = groupTagsByPrefix([
      facet(1, 'genre: fantasy', 10),
      facet(2, 'Genre:sci-fi', 4),
      facet(3, 'Fiction/Epic', 3),
      facet(4, 'Fiction / Cozy', 2),
      facet(5, 'Mood > Dark', 1),
      facet(6, 'favourites', 9),
    ])

    expect(result.groups.map((group) => group.prefix)).toEqual(['genre', 'Fiction'])
    expect(result.groups[0]?.tags.map((member) => member.label)).toEqual(['fantasy', 'sci-fi'])
    expect(result.groups[0]?.tagCountSum).toBe(14)
    expect(result.groups[1]?.tags.map((member) => member.label)).toEqual(['Epic', 'Cozy'])
    expect(result.ungrouped.map((tag) => tag.name)).toEqual(['Mood > Dark', 'favourites'])
  })

  it('leaves names with a leading or trailing separator ungrouped', () => {
    const result = groupTagsByPrefix([facet(1, ':odd'), facet(2, ':odd too'), facet(3, 'trailing/')])
    expect(result.groups).toEqual([])
    expect(result.ungrouped).toHaveLength(3)
  })
})
