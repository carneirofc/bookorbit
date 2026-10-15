import { computed, type Ref } from 'vue'
import { MAX_TAG_FACETS_ONLY_TAGS, type TagFacetsQuery } from '@bookorbit/types'
import { hasTagRule, narrowFilter } from '../lib/tag-browser-filter'
import { useTagFacets } from './useTagFacets'
import type { TagBrowserScope } from './useTagBrowser'

/** One slot of the baseline request goes to the inspected tag itself. */
export const RELATED_TAG_LIMIT = MAX_TAG_FACETS_ONLY_TAGS - 1

export type RelatedTagSort = 'together' | 'affinity'

export interface RelatedTag {
  name: string
  /** Books carrying both the inspected tag and this one. */
  together: number
  /** Share of the inspected tag's books that also carry this tag. */
  shareOfTag: number
  /** Books carrying this tag anywhere in scope; null until the baseline counts arrive. */
  total: number | null
  /** Share of this tag's books that also carry the inspected tag. */
  shareOfRelated: number | null
  /**
   * How much more often the pair occurs than chance would suggest: the share of the inspected
   * tag's books carrying this tag, over the share of all scoped books carrying it. Above 1 means
   * the tags attract each other; popular tags that go with everything stay near 1.
   */
  affinity: number | null
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0
}

/**
 * Co-occurrence for one tag within the browser scope: which tags show up on its books and how
 * strongly they are tied to it. Two bounded requests: the related tags, then the scoped totals
 * of exactly those tags, which turn raw counts into shares and affinity.
 */
export function useTagInsight(tag: Ref<string | null>, scope: Ref<TagBrowserScope | null>, sortBy: Ref<RelatedTagSort>) {
  const relatedRequest = computed<TagFacetsQuery | null>(() => {
    if (!tag.value || !scope.value) return null
    return {
      filter: narrowFilter(scope.value.filter, hasTagRule(tag.value)),
      ...(scope.value.q ? { q: scope.value.q } : {}),
      excludeTags: [tag.value],
      sort: 'count',
      limit: RELATED_TAG_LIMIT,
    }
  })
  const related = useTagFacets(relatedRequest)

  const baselineRequest = computed<TagFacetsQuery | null>(() => {
    if (!tag.value || !scope.value || related.loading.value) return null
    return {
      ...(scope.value.filter ? { filter: scope.value.filter } : {}),
      ...(scope.value.q ? { q: scope.value.q } : {}),
      onlyTags: [tag.value, ...related.tags.value.map((facet) => facet.name)],
      sort: 'count',
      limit: MAX_TAG_FACETS_ONLY_TAGS,
    }
  })
  const baseline = useTagFacets(baselineRequest)

  const tagTotal = computed(() => related.totalBooks.value)
  const scopeTotal = computed(() => baseline.totalBooks.value)
  const shareOfScope = computed(() => ratio(tagTotal.value, scopeTotal.value))

  const relatedTags = computed<RelatedTag[]>(() => {
    const totals = new Map(baseline.tags.value.map((facet) => [facet.name, facet.count]))
    const rows = related.tags.value.map((facet) => {
      const total = totals.get(facet.name) ?? null
      const shareOfTag = ratio(facet.count, tagTotal.value)
      return {
        name: facet.name,
        together: facet.count,
        shareOfTag,
        total,
        shareOfRelated: total ? ratio(facet.count, total) : null,
        affinity: total && scopeTotal.value ? shareOfTag / ratio(total, scopeTotal.value) : null,
      }
    })
    if (sortBy.value === 'affinity') rows.sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0) || b.together - a.together)
    return rows
  })

  const loading = computed(() => related.loading.value || baseline.loading.value)
  const error = computed(() => related.error.value ?? baseline.error.value)

  function reload() {
    void related.reload()
    void baseline.reload()
  }

  return { tagTotal, scopeTotal, shareOfScope, relatedTags, loading, error, reload }
}
