import { computed, ref, watch } from 'vue'
import { refDebounced } from '@vueuse/core'
import {
  DEFAULT_TAG_FACETS_LIMIT,
  MAX_TAG_FACETS_LIMIT,
  type GroupRule,
  type SortSpec,
  type TagFacetSort,
  type TagFacetsQuery,
} from '@bookorbit/types'
import { storage } from '@/services/storage'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { DEFAULT_SORT, copySort } from '@/features/book/lib/sort-defaults'
import {
  MAX_RULE_VALUES,
  combineFilters,
  excludedTagRules,
  libraryRule,
  panelRule,
  tagsSelectedBefore,
  type TagMatchMode,
  type TagPanelSelection,
} from '../lib/tag-browser-filter'

/** Five panels of up to 20 tags each keeps the exclusion list inside the server's bound. */
export const MAX_TAG_PANELS = 5
export const MAX_TAGS_PER_PANEL = MAX_RULE_VALUES
export const MAX_EXCLUDED_TAGS = 40

const EXCLUDED_LIBRARIES_KEY = 'bookorbit:tagBrowser:excludedLibraryIds'
const FACET_SORT_KEY = 'bookorbit:tagBrowser:facetSort'
const GROUP_BY_PREFIX_KEY = 'bookorbit:tagBrowser:groupByPrefix'
const SEARCH_DEBOUNCE_MS = 300

export interface TagPanel extends TagPanelSelection {
  key: number
}

/** The books the browser draws from before any panel narrows them: libraries, exclusions, extra filters and search. */
export interface TagBrowserScope {
  filter?: GroupRule
  q?: string
}

/**
 * State for the tag browser: which libraries are in play, the cascade of tag panels, the excluded
 * tags and the extra filters. Each panel narrows the books the next one draws its tags from, and
 * the book results apply every panel at once. Exclusions sit in the base scope, so they hide books
 * from every panel as well as from the results. Excluded libraries are remembered rather than included
 * ones, so a library created later shows up without the user opting in.
 */
export function useTagBrowser() {
  const { libraries, fetchLibraries } = useLibraries()

  const excludedLibraryIds = ref<number[]>(storage.get<number[]>(EXCLUDED_LIBRARIES_KEY, []))
  const facetSort = ref<TagFacetSort>(storage.get<TagFacetSort>(FACET_SORT_KEY, 'count'))
  const groupByPrefix = ref<boolean>(storage.get<boolean>(GROUP_BY_PREFIX_KEY, false))
  const excludedTags = ref<string[]>([])
  const extraFilter = ref<GroupRule | undefined>(undefined)
  const q = ref('')
  const debouncedQ = refDebounced(q, SEARCH_DEBOUNCE_MS)
  const searchQuery = computed(() => debouncedQ.value.trim())
  const sort = ref<SortSpec[]>(copySort(DEFAULT_SORT))

  let panelSeq = 0
  function newPanel(): TagPanel {
    panelSeq += 1
    return { key: panelSeq, selected: [], match: 'any' }
  }
  const panels = ref<TagPanel[]>([newPanel()])

  watch(excludedLibraryIds, (ids) => storage.set(EXCLUDED_LIBRARIES_KEY, ids), { deep: true })
  watch(facetSort, (value) => storage.set(FACET_SORT_KEY, value))
  watch(groupByPrefix, (value) => storage.set(GROUP_BY_PREFIX_KEY, value))

  const bookLibraries = computed(() => libraries.value.filter((library) => library.type === 'books'))
  const selectedLibraries = computed(() => bookLibraries.value.filter((library) => !excludedLibraryIds.value.includes(library.id)))
  const hasLibrarySelection = computed(() => selectedLibraries.value.length > 0)

  function isLibrarySelected(id: number): boolean {
    return !excludedLibraryIds.value.includes(id)
  }

  function toggleLibrary(id: number) {
    excludedLibraryIds.value = isLibrarySelected(id) ? [...excludedLibraryIds.value, id] : excludedLibraryIds.value.filter((value) => value !== id)
  }

  function selectAllLibraries() {
    excludedLibraryIds.value = []
  }

  function selectOnlyLibrary(id: number) {
    excludedLibraryIds.value = bookLibraries.value.filter((library) => library.id !== id).map((library) => library.id)
  }

  const baseRules = computed(() => [
    libraryRule(
      selectedLibraries.value.map((library) => library.name),
      bookLibraries.value.map((library) => library.name),
    ),
    ...excludedTagRules(excludedTags.value),
  ])

  const scope = computed<TagBrowserScope | null>(() => {
    if (!hasLibrarySelection.value) return null
    const filter = combineFilters(baseRules.value, extraFilter.value)
    return {
      ...(filter ? { filter } : {}),
      ...(searchQuery.value ? { q: searchQuery.value } : {}),
    }
  })

  function filterThroughPanel(count: number): GroupRule | undefined {
    const tagRules = panels.value.slice(0, count).map(panelRule)
    return combineFilters([...baseRules.value, ...tagRules], extraFilter.value)
  }

  const resultsFilter = computed(() => filterThroughPanel(panels.value.length))

  const facetRequests = computed<Array<TagFacetsQuery | null>>(() =>
    panels.value.map((_, index) => {
      if (!hasLibrarySelection.value) return null
      const filter = filterThroughPanel(index)
      return {
        ...(filter ? { filter } : {}),
        ...(searchQuery.value ? { q: searchQuery.value } : {}),
        excludeTags: tagsSelectedBefore(panels.value, index),
        sort: facetSort.value,
        // Grouping happens on the client, so it needs as many tags as the server will hand out.
        limit: groupByPrefix.value ? MAX_TAG_FACETS_LIMIT : DEFAULT_TAG_FACETS_LIMIT,
      }
    }),
  )

  /** Changing a panel invalidates the ones after it, since their tags came from the old selection. */
  function settlePanelsAfter(index: number) {
    const kept = panels.value.slice(0, index + 1)
    const last = kept[kept.length - 1]
    if (last && last.selected.length > 0 && kept.length < MAX_TAG_PANELS) kept.push(newPanel())
    panels.value = kept
  }

  function updatePanel(index: number, patch: Partial<TagPanelSelection>) {
    const current = panels.value[index]
    if (!current) return
    panels.value = panels.value.map((panel, i) => (i === index ? { ...panel, ...patch } : panel))
    settlePanelsAfter(index)
  }

  function toggleTag(index: number, name: string) {
    const current = panels.value[index]
    if (!current) return
    if (current.selected.includes(name)) {
      updatePanel(index, { selected: current.selected.filter((value) => value !== name) })
    } else if (current.selected.length < MAX_TAGS_PER_PANEL) {
      updatePanel(index, { selected: [...current.selected, name] })
    }
  }

  function setPanelMatch(index: number, match: TagMatchMode) {
    updatePanel(index, { match })
  }

  function clearPanel(index: number) {
    updatePanel(index, { selected: [] })
  }

  /** Picks every given tag in one panel as an any-match, which is how a whole prefix group is included. */
  function includeTagsInPanel(index: number, names: string[]) {
    const current = panels.value[index]
    if (!current) return
    const selected = [...new Set([...current.selected, ...names])].slice(0, MAX_TAGS_PER_PANEL)
    unexclude(names)
    updatePanel(index, { selected, match: 'any' })
  }

  /** Narrows the current selection by one more tag: it lands in the last panel, which ANDs it with the rest. */
  function includeTag(name: string) {
    unexclude([name])
    if (includedTags.value.includes(name)) return
    const index = panels.value.length - 1
    const last = panels.value[index]
    if (!last || last.selected.length >= MAX_TAGS_PER_PANEL) return
    updatePanel(index, { selected: [...last.selected, name] })
  }

  function excludeTags(names: string[]) {
    const removed = new Set(names)
    const firstAffected = panels.value.findIndex((panel) => panel.selected.some((name) => removed.has(name)))
    if (firstAffected !== -1) {
      panels.value = panels.value.map((panel) => ({ ...panel, selected: panel.selected.filter((name) => !removed.has(name)) }))
      settlePanelsAfter(firstAffected)
    }
    excludedTags.value = [...new Set([...excludedTags.value, ...names])].slice(0, MAX_EXCLUDED_TAGS)
  }

  function excludeTag(name: string) {
    excludeTags([name])
  }

  function unexclude(names: string[]) {
    const restored = new Set(names)
    if (!excludedTags.value.some((name) => restored.has(name))) return
    excludedTags.value = excludedTags.value.filter((name) => !restored.has(name))
  }

  function unexcludeTag(name: string) {
    unexclude([name])
  }

  function clearExcludedTags() {
    excludedTags.value = []
  }

  function resetPanels() {
    panels.value = [newPanel()]
  }

  function resetAll() {
    resetPanels()
    excludedTags.value = []
    extraFilter.value = undefined
    q.value = ''
  }

  const includedTags = computed(() => [...new Set(panels.value.flatMap((panel) => panel.selected))])
  const selectedTagCount = computed(() => panels.value.reduce((sum, panel) => sum + panel.selected.length, 0))
  const canExcludeMore = computed(() => excludedTags.value.length < MAX_EXCLUDED_TAGS)
  const extraFilterCount = computed(() => extraFilter.value?.rules.length ?? 0)

  return {
    libraries: bookLibraries,
    selectedLibraries,
    hasLibrarySelection,
    fetchLibraries,
    isLibrarySelected,
    toggleLibrary,
    selectAllLibraries,
    selectOnlyLibrary,
    panels,
    facetRequests,
    facetSort,
    groupByPrefix,
    scope,
    toggleTag,
    includeTag,
    includeTagsInPanel,
    excludeTag,
    excludeTags,
    unexcludeTag,
    clearExcludedTags,
    excludedTags,
    canExcludeMore,
    includedTags,
    setPanelMatch,
    clearPanel,
    resetPanels,
    resetAll,
    extraFilter,
    extraFilterCount,
    q,
    searchQuery,
    sort,
    resultsFilter,
    selectedTagCount,
  }
}
