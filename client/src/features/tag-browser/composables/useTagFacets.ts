import { computed, ref, shallowRef, watch, type Ref } from 'vue'
import type { TagFacet, TagFacetsQuery } from '@bookorbit/types'
import { fetchTagFacets } from '../api/tag-facets'

/**
 * Loads the tag counts for one browser panel. A changed request aborts the one in flight, so a
 * fast run of clicks only ever renders the counts for the latest selection.
 */
export function useTagFacets(request: Ref<TagFacetsQuery | null>) {
  const tags = shallowRef<TagFacet[]>([])
  const totalBooks = ref(0)
  const truncated = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)

  let controller: AbortController | null = null
  const requestKey = computed(() => (request.value ? JSON.stringify(request.value) : null))

  async function load() {
    controller?.abort()
    const body = request.value
    if (!body) {
      tags.value = []
      totalBooks.value = 0
      truncated.value = false
      loading.value = false
      return
    }
    const current = new AbortController()
    controller = current
    loading.value = true
    error.value = null
    try {
      const data = await fetchTagFacets(body, current.signal)
      if (controller !== current) return
      tags.value = data.tags
      totalBooks.value = data.totalBooks
      truncated.value = data.truncated
    } catch (cause: unknown) {
      if (controller !== current || current.signal.aborted) return
      error.value = cause instanceof Error ? cause.message : 'Failed to load tags'
    } finally {
      if (controller === current) loading.value = false
    }
  }

  watch(requestKey, () => void load(), { immediate: true })

  return { tags, totalBooks, truncated, loading, error, reload: load }
}
