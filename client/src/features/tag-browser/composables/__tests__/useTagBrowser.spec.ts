import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Library } from '@bookorbit/types'

const libraries = ref<Library[]>([])

vi.mock('@/features/library/composables/useLibraries', () => ({
  useLibraries: () => ({ libraries, fetchLibraries: vi.fn<() => Promise<void>>() }),
}))

import { MAX_TAG_PANELS, MAX_TAGS_PER_PANEL, useTagBrowser } from '../useTagBrowser'

function library(id: number, name: string, type: Library['type'] = 'books'): Library {
  return { id, name, type } as Library
}

describe('useTagBrowser', () => {
  beforeEach(() => {
    localStorage.clear()
    libraries.value = [library(1, 'Fiction'), library(2, 'Comics'), library(3, 'Podcasts', 'podcasts')]
  })

  it('offers only book libraries, all selected by default', () => {
    const browser = useTagBrowser()
    expect(browser.libraries.value.map((lib) => lib.name)).toEqual(['Fiction', 'Comics'])
    expect(browser.selectedLibraries.value).toHaveLength(2)
    expect(browser.resultsFilter.value).toBeUndefined()
  })

  it('opens the next panel once a tag is picked and narrows it by the earlier panels', () => {
    const browser = useTagBrowser()
    browser.toggleTag(0, 'fantasy')

    expect(browser.panels.value).toHaveLength(2)
    expect(browser.facetRequests.value[1]).toMatchObject({
      excludeTags: ['fantasy'],
      filter: { type: 'group', join: 'AND', rules: [{ field: 'tag', operator: 'includesAny', value: ['fantasy'] }] },
    })
    expect(browser.facetRequests.value[0]?.filter).toBeUndefined()
  })

  it('drops later panels when an earlier selection changes', () => {
    const browser = useTagBrowser()
    browser.toggleTag(0, 'fantasy')
    browser.toggleTag(1, 'dragons')
    expect(browser.panels.value).toHaveLength(3)

    browser.toggleTag(0, 'magic')
    expect(browser.panels.value).toHaveLength(2)
    expect(browser.panels.value[1]?.selected).toEqual([])
  })

  it('closes the following panel when a panel is cleared', () => {
    const browser = useTagBrowser()
    browser.toggleTag(0, 'fantasy')
    browser.clearPanel(0)
    expect(browser.panels.value).toHaveLength(1)
  })

  it('caps the number of panels and tags per panel', () => {
    const browser = useTagBrowser()
    for (let i = 0; i < MAX_TAG_PANELS; i++) browser.toggleTag(i, `tag-${i}`)
    expect(browser.panels.value).toHaveLength(MAX_TAG_PANELS)

    for (let i = 0; i < MAX_TAGS_PER_PANEL + 5; i++) browser.toggleTag(0, `extra-${i}`)
    expect(browser.panels.value[0]?.selected).toHaveLength(MAX_TAGS_PER_PANEL)
  })

  it('restricts results to the selected libraries and stops querying when none are selected', () => {
    const browser = useTagBrowser()
    browser.toggleLibrary(2)
    expect(browser.resultsFilter.value?.rules).toEqual([{ type: 'rule', field: 'library', operator: 'includesAny', value: ['Fiction'] }])

    browser.toggleLibrary(1)
    expect(browser.hasLibrarySelection.value).toBe(false)
    expect(browser.facetRequests.value[0]).toBeNull()

    browser.selectAllLibraries()
    expect(browser.resultsFilter.value).toBeUndefined()
  })

  it('applies every panel and the extra filters to the results', () => {
    const browser = useTagBrowser()
    browser.toggleTag(0, 'fantasy')
    browser.toggleTag(1, 'dragons')
    browser.setPanelMatch(1, 'all')
    browser.extraFilter.value = { type: 'group', join: 'AND', rules: [{ type: 'rule', field: 'rating', operator: 'gte', value: 4 }] }

    expect(browser.resultsFilter.value?.rules).toEqual([
      { type: 'rule', field: 'tag', operator: 'includesAny', value: ['fantasy'] },
      { type: 'rule', field: 'tag', operator: 'includesAll', value: ['dragons'] },
      { type: 'rule', field: 'rating', operator: 'gte', value: 4 },
    ])
  })

  it('excludes a tag everywhere, dropping it from the panels and narrowing the scope', () => {
    const browser = useTagBrowser()
    browser.toggleTag(0, 'fantasy')
    browser.toggleTag(1, 'horror')
    browser.excludeTag('horror')

    expect(browser.panels.value[1]?.selected).toEqual([])
    expect(browser.excludedTags.value).toEqual(['horror'])
    expect(browser.scope.value?.filter?.rules).toEqual([{ type: 'rule', field: 'tag', operator: 'excludesAll', value: ['horror'] }])
    expect(browser.facetRequests.value[0]?.filter?.rules).toContainEqual({ type: 'rule', field: 'tag', operator: 'excludesAll', value: ['horror'] })
  })

  it('stops excluding a tag once it is included again', () => {
    const browser = useTagBrowser()
    browser.excludeTag('horror')
    browser.includeTag('horror')

    expect(browser.excludedTags.value).toEqual([])
    expect(browser.includedTags.value).toEqual(['horror'])
  })

  it('includes a tag from the insight view by ANDing it in the last panel', () => {
    const browser = useTagBrowser()
    browser.toggleTag(0, 'fantasy')
    browser.includeTag('dragons')
    browser.includeTag('dragons')

    expect(browser.panels.value.map((panel) => panel.selected)).toEqual([['fantasy'], ['dragons'], []])
  })

  it('includes a whole prefix group as an any-match in one panel', () => {
    const browser = useTagBrowser()
    browser.setPanelMatch(0, 'all')
    browser.includeTagsInPanel(0, ['genre: fantasy', 'genre: sci-fi'])

    expect(browser.panels.value[0]).toMatchObject({ selected: ['genre: fantasy', 'genre: sci-fi'], match: 'any' })
  })

  it('clears exclusions on reset', () => {
    const browser = useTagBrowser()
    browser.excludeTags(['a', 'b'])
    browser.resetAll()
    expect(browser.excludedTags.value).toEqual([])
  })
})
