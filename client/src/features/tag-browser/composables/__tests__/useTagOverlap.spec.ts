import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { TagFacetsQuery, TagFacetsResponse } from '@bookorbit/types'

const fetchTagFacets = vi.hoisted(() => vi.fn<(body: TagFacetsQuery, signal?: AbortSignal) => Promise<TagFacetsResponse>>())

vi.mock('../../api/tag-facets', () => ({ fetchTagFacets }))

import { MAX_OVERLAP_TAGS, useTagOverlap } from '../useTagOverlap'

async function settle() {
  for (let i = 0; i < 5; i++) {
    await nextTick()
    await Promise.resolve()
  }
}

const counts: Record<string, Record<string, number>> = {
  fantasy: { fantasy: 50, magic: 20 },
  magic: { fantasy: 20, magic: 30 },
}

describe('useTagOverlap', () => {
  it('builds a symmetric pair matrix with one bounded request per tag', async () => {
    fetchTagFacets.mockImplementation(async (body) => {
      const lastRule = body.filter!.rules.at(-1) as { value: string[] }
      const name = lastRule.value[0]!
      return {
        totalBooks: counts[name]![name]!,
        truncated: false,
        tags: Object.entries(counts[name]!).map(([tag, count], id) => ({ id, name: tag, count })),
      }
    })
    const { overlap } = useTagOverlap(ref(['fantasy', 'magic']), ref({}))
    await settle()

    expect(fetchTagFacets).toHaveBeenCalledTimes(2)
    expect(fetchTagFacets.mock.calls[0]?.[0].onlyTags).toEqual(['fantasy', 'magic'])
    expect(overlap.value?.totals).toEqual({ fantasy: 50, magic: 30 })
    expect(overlap.value?.pairs.fantasy?.magic).toBe(20)
    expect(overlap.value?.pairs.magic?.fantasy).toBe(20)
  })

  it('needs at least two tags and caps how many it compares', async () => {
    fetchTagFacets.mockClear()
    fetchTagFacets.mockResolvedValue({ totalBooks: 0, truncated: false, tags: [] })
    const single = useTagOverlap(ref(['fantasy']), ref({}))
    await settle()
    expect(single.overlap.value).toBeNull()
    expect(fetchTagFacets).not.toHaveBeenCalled()

    const many = useTagOverlap(ref(Array.from({ length: MAX_OVERLAP_TAGS + 3 }, (_, i) => `tag-${i}`)), ref({}))
    await settle()
    expect(fetchTagFacets).toHaveBeenCalledTimes(MAX_OVERLAP_TAGS)
    expect(many.hiddenCount.value).toBe(3)
  })
})
