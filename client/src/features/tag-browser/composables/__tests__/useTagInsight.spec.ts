import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { TagFacetsQuery, TagFacetsResponse } from '@bookorbit/types'

const fetchTagFacets = vi.hoisted(() => vi.fn<(body: TagFacetsQuery, signal?: AbortSignal) => Promise<TagFacetsResponse>>())

vi.mock('../../api/tag-facets', () => ({ fetchTagFacets }))

import { useTagInsight, type RelatedTagSort } from '../useTagInsight'

async function settle() {
  for (let i = 0; i < 5; i++) {
    await nextTick()
    await Promise.resolve()
  }
}

describe('useTagInsight', () => {
  it('turns co-occurrence counts into shares and affinity', async () => {
    fetchTagFacets.mockImplementation(async (body) => {
      if (body.onlyTags) {
        // Scope: 1000 books. fantasy on 200, magic on 100, books on 800.
        return {
          totalBooks: 1000,
          truncated: false,
          tags: [
            { id: 1, name: 'fantasy', count: 200 },
            { id: 2, name: 'magic', count: 100 },
            { id: 3, name: 'books', count: 800 },
          ],
        }
      }
      return {
        totalBooks: 200,
        truncated: false,
        tags: [
          { id: 3, name: 'books', count: 160 },
          { id: 2, name: 'magic', count: 80 },
        ],
      }
    })
    const sortBy = ref<RelatedTagSort>('together')
    const insight = useTagInsight(ref('fantasy'), ref({}), sortBy)
    await settle()

    expect(fetchTagFacets.mock.calls[0]?.[0]).toMatchObject({
      excludeTags: ['fantasy'],
      filter: { rules: [{ field: 'tag', operator: 'includesAny', value: ['fantasy'] }] },
    })
    expect(insight.tagTotal.value).toBe(200)
    expect(insight.shareOfScope.value).toBeCloseTo(0.2)

    const [books, magic] = insight.relatedTags.value
    expect(books).toMatchObject({ name: 'books', together: 160, shareOfTag: 0.8, total: 800, shareOfRelated: 0.2 })
    expect(books?.affinity).toBeCloseTo(1)
    expect(magic).toMatchObject({ name: 'magic', together: 80, shareOfTag: 0.4, total: 100, shareOfRelated: 0.8 })
    expect(magic?.affinity).toBeCloseTo(4)

    sortBy.value = 'affinity'
    expect(insight.relatedTags.value.map((row) => row.name)).toEqual(['magic', 'books'])
  })

  it('does not query without a tag or scope', async () => {
    fetchTagFacets.mockClear()
    useTagInsight(ref(null), ref({}), ref<RelatedTagSort>('together'))
    useTagInsight(ref('fantasy'), ref(null), ref<RelatedTagSort>('together'))
    await settle()
    expect(fetchTagFacets).not.toHaveBeenCalled()
  })
})
