import { computed, ref, shallowRef, watch, type Ref } from 'vue'
import { MAX_TAG_FACETS_ONLY_TAGS } from '@bookorbit/types'
import { fetchTagFacets } from '../api/tag-facets'
import { hasTagRule, narrowFilter } from '../lib/tag-browser-filter'
import type { TagBrowserScope } from './useTagBrowser'

/** One request per tag, so the matrix is kept small enough to load at a glance. */
export const MAX_OVERLAP_TAGS = 8

export interface TagOverlap {
  tags: string[]
  /** Books carrying each tag within the scope. */
  totals: Record<string, number>
  /** `pairs[a][b]`: books carrying both a and b. Symmetric. */
  pairs: Record<string, Record<string, number>>
}

/**
 * Pairwise overlap between the tags the user has picked, counted over the browser scope rather
 * than the panel cascade, which would make every cell equal. Each row is one facet request
 * restricted to the picked tags, so the cost grows with the tag count, not with the library.
 */
export function useTagOverlap(tags: Ref<string[]>, scope: Ref<TagBrowserScope | null>) {
  const overlap = shallowRef<TagOverlap | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const visibleTags = computed(() => tags.value.slice(0, MAX_OVERLAP_TAGS))
  const requestKey = computed(() => (visibleTags.value.length >= 2 && scope.value ? JSON.stringify([visibleTags.value, scope.value]) : null))

  let controller: AbortController | null = null

  async function load() {
    controller?.abort()
    const names = visibleTags.value
    const currentScope = scope.value
    if (names.length < 2 || !currentScope) {
      overlap.value = null
      loading.value = false
      return
    }
    const current = new AbortController()
    controller = current
    loading.value = true
    error.value = null
    try {
      const rows = await Promise.all(
        names.map((name) =>
          fetchTagFacets(
            {
              filter: narrowFilter(currentScope.filter, hasTagRule(name)),
              ...(currentScope.q ? { q: currentScope.q } : {}),
              onlyTags: names,
              limit: MAX_TAG_FACETS_ONLY_TAGS,
            },
            current.signal,
          ),
        ),
      )
      if (controller !== current) return
      const totals: Record<string, number> = {}
      const pairs: Record<string, Record<string, number>> = {}
      names.forEach((name, index) => {
        const row = rows[index]!
        totals[name] = row.totalBooks
        pairs[name] = Object.fromEntries(names.map((other) => [other, row.tags.find((facet) => facet.name === other)?.count ?? 0]))
      })
      overlap.value = { tags: names, totals, pairs }
    } catch (cause: unknown) {
      if (controller !== current || current.signal.aborted) return
      error.value = cause instanceof Error ? cause.message : 'Failed to load tag overlap'
    } finally {
      if (controller === current) loading.value = false
    }
  }

  watch(requestKey, () => void load(), { immediate: true })

  const hiddenCount = computed(() => Math.max(0, tags.value.length - MAX_OVERLAP_TAGS))

  return { overlap, loading, error, hiddenCount, reload: load }
}
