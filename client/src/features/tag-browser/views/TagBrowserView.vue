<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ChevronDown, ChevronUp, FolderOpen, FolderTree, RotateCcw, SlidersHorizontal } from '@lucide/vue'
import type { BookCard, GroupRule, SortSpec, TagFacetSort } from '@bookorbit/types'
import BrowseHeader from '@/components/browse-header/BrowseHeader.vue'
import BrowseSearchField from '@/components/browse-header/BrowseSearchField.vue'
import BrowseViewControls from '@/components/browse-header/BrowseViewControls.vue'
import { barDivider } from '@/components/browse-header/browse-header'
import ViewHeaderDisplayControls from '@/components/view-header/ViewHeaderDisplayControls.vue'
import { formatNumber } from '@/i18n/formatters'
import VirtualBookGrid from '@/features/book/components/VirtualBookGrid.vue'
import BookFilterBuilder from '@/features/book/components/BookFilterBuilder.vue'
import BookSortBuilder from '@/features/book/components/BookSortBuilder.vue'
import DeleteBookDialog from '@/features/book/components/DeleteBookDialog.vue'
import AddToCollectionSheet from '@/features/collection/components/AddToCollectionSheet.vue'
import { BOOK_WINDOW_BLOCK_SIZE, useBookWindow, type BookWindowQuery } from '@/features/book/composables/useBookWindow'
import { useBookViewContext } from '@/features/book/composables/useBookViewContext'
import { useDeleteBook } from '@/features/book/composables/useDeleteBook'
import { useScrollRestoreOnActivate } from '@/features/book/composables/useScrollRestoreOnActivate'
import { useDisplaySettings } from '@/composables/useDisplaySettings'
import TagFacetPanel from '../components/TagFacetPanel.vue'
import TagBrowserLibraryPicker from '../components/TagBrowserLibraryPicker.vue'
import TagInsightSheet from '../components/TagInsightSheet.vue'
import TagOverlapMatrix from '../components/TagOverlapMatrix.vue'
import TagSelectionBar from '../components/TagSelectionBar.vue'
import { MAX_TAGS_PER_PANEL, useTagBrowser } from '../composables/useTagBrowser'
import type { TagMatchMode } from '../lib/tag-browser-filter'

defineOptions({ name: 'TagBrowserView' })

type BookActionType = 'quick-view' | 'add-to-collection' | 'move-to-library' | 'delete'

const { t } = useI18n()
const router = useRouter()

const {
  libraries,
  selectedLibraries,
  hasLibrarySelection,
  fetchLibraries,
  isLibrarySelected,
  toggleLibrary,
  selectAllLibraries,
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
  resetAll,
  extraFilter,
  extraFilterCount,
  q,
  searchQuery,
  sort,
  resultsFilter,
  selectedTagCount,
} = useTagBrowser()

const { portraitCoverSize, portraitGridGap } = useDisplaySettings()
const coverSize = ref(portraitCoverSize.value)
const gridGap = ref(portraitGridGap.value)

const filtersOpen = ref(false)
const panelsOpen = ref(true)
const scrollRef = ref<HTMLElement | null>(null)
useScrollRestoreOnActivate(scrollRef)

const endpoint = computed(() => (hasLibrarySelection.value ? '/api/v1/books/query' : null))
const query = computed<BookWindowQuery>(() => ({
  sort: sort.value,
  ...(resultsFilter.value ? { filter: resultsFilter.value } : {}),
  ...(searchQuery.value ? { q: searchQuery.value } : {}),
}))

const { slots, total, loading, initialized, error, ensureRange, retry, contiguousPrefix, removeBooks, updateBook } = useBookWindow({
  endpoint,
  query,
})

function loadMore() {
  const start = contiguousPrefix.value.length
  return ensureRange(start, start + BOOK_WINDOW_BLOCK_SIZE - 1)
}

useBookViewContext(slots, total, loadMore)
const foldedCount = computed(() => formatNumber(total.value))

const {
  pendingId: deleteBookId,
  deleting: deletingBook,
  promptDelete,
  cancelDelete,
  confirmDelete,
} = useDeleteBook((id) => {
  removeBooks([id])
})

const collectionBookId = ref<number | null>(null)
const addToCollectionOpen = computed(() => collectionBookId.value !== null)
const collectionPayload = computed(() => ({ bookIds: collectionBookId.value === null ? [] : [collectionBookId.value] }))

const hasActiveNarrowing = computed(
  () => selectedTagCount.value > 0 || excludedTags.value.length > 0 || extraFilterCount.value > 0 || q.value.trim().length > 0,
)

const inspectedTag = ref<string | null>(null)
const insightOpen = ref(false)
const showEmptyResults = computed(() => hasLibrarySelection.value && initialized.value && !error.value && total.value === 0)
const facetSortOptions: TagFacetSort[] = ['count', 'name']

onMounted(() => {
  void fetchLibraries()
})

function handleSearchQuery(value: string) {
  q.value = value
}

function handleClearSearch() {
  q.value = ''
}

function handleCoverSizeUpdate(value: number) {
  coverSize.value = value
}

function handleGridGapUpdate(value: number) {
  gridGap.value = value
}

function handleToggleLibrary(id: number) {
  toggleLibrary(id)
}

function handleSelectAllLibraries() {
  selectAllLibraries()
}

function handleToggleTag(index: number, name: string) {
  toggleTag(index, name)
}

function handlePanelMatch(index: number, mode: TagMatchMode) {
  setPanelMatch(index, mode)
}

function handleClearPanel(index: number) {
  clearPanel(index)
}

function handleExcludeTag(name: string) {
  excludeTag(name)
}

function handleExcludeGroup(names: string[]) {
  excludeTags(names)
}

function handleIncludeGroup(index: number, names: string[]) {
  includeTagsInPanel(index, names)
}

function handleIncludeTag(name: string) {
  includeTag(name)
}

function handleRemoveExcluded(name: string) {
  unexcludeTag(name)
}

function handleClearExcluded() {
  clearExcludedTags()
}

function handleInspectTag(name: string) {
  inspectedTag.value = name
  insightOpen.value = true
}

function handleInsightOpen(open: boolean) {
  insightOpen.value = open
}

function handleToggleGroupByPrefix() {
  groupByPrefix.value = !groupByPrefix.value
}

function handleFacetSort(value: TagFacetSort) {
  facetSort.value = value
}

function handleExtraFilter(value: GroupRule | undefined) {
  extraFilter.value = value
}

function handleSort(value: SortSpec[]) {
  sort.value = value
}

function handleToggleFilters() {
  filtersOpen.value = !filtersOpen.value
}

function handleTogglePanels() {
  panelsOpen.value = !panelsOpen.value
}

function handleReset() {
  resetAll()
}

function handleRange(startIndex: number, endIndex: number) {
  void ensureRange(startIndex, endIndex)
}

function handleRetry() {
  retry()
}

function handleBookAction(book: BookCard, action: BookActionType) {
  if (action === 'quick-view') {
    void router.push({ name: 'book-detail', params: { bookId: book.id } })
    return
  }
  if (action === 'add-to-collection') {
    collectionBookId.value = book.id
    return
  }
  if (action === 'delete') promptDelete(book.id)
}

function handleCollectionOpen(open: boolean) {
  if (!open) collectionBookId.value = null
}

function handleCollectionDone() {
  collectionBookId.value = null
}
</script>

<template>
  <section class="flex h-full flex-col">
    <BrowseHeader
      :eyebrow="t('components.browseHeader.eyebrow.browse')"
      :title="t('tagBrowser.title')"
      icon="Tags"
      fallback-icon="Tags"
      :folded-count="foldedCount"
      :scroll-container="scrollRef"
    >
      <template #facts>
        <span class="truncate">{{ t('components.browseHeader.facts.books', { count: total }) }}</span>
      </template>

      <template #bar>
        <BrowseSearchField
          :model-value="q"
          :placeholder="t('tagBrowser.searchPlaceholder')"
          :active="q.length > 0"
          @update:model-value="handleSearchQuery"
          @clear="handleClearSearch"
        />
        <span :class="barDivider" aria-hidden="true" />
        <BrowseViewControls view-mode="grid" :allowed-view-modes="['grid']" :show-selection="false">
          <template #display>
            <ViewHeaderDisplayControls
              view-mode="grid"
              :cover-size="coverSize"
              :grid-gap="gridGap"
              @update:cover-size="handleCoverSizeUpdate"
              @update:grid-gap="handleGridGapUpdate"
            />
          </template>
        </BrowseViewControls>
      </template>
    </BrowseHeader>

    <div ref="scrollRef" class="min-h-0 flex-1 overflow-y-auto">
      <div class="flex flex-col gap-4 px-4 py-4 sm:px-6">
        <TagBrowserLibraryPicker
          v-if="libraries.length > 1"
          :libraries="libraries"
          :is-selected="isLibrarySelected"
          :selected-count="selectedLibraries.length"
          @toggle="handleToggleLibrary"
          @select-all="handleSelectAllLibraries"
        />

        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors"
            :class="
              filtersOpen || extraFilterCount > 0 ? 'border-primary text-foreground' : 'border-border text-muted-foreground hover:text-foreground'
            "
            :aria-expanded="filtersOpen"
            @click="handleToggleFilters"
          >
            <SlidersHorizontal :size="14" />
            {{ t('tagBrowser.filters.toggle') }}
            <span v-if="extraFilterCount > 0" class="rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">{{
              extraFilterCount
            }}</span>
          </button>

          <div
            class="inline-flex h-8 items-center rounded-md border border-border p-0.5 text-xs"
            role="group"
            :aria-label="t('tagBrowser.tagOrder.label')"
          >
            <button
              v-for="option in facetSortOptions"
              :key="option"
              type="button"
              class="h-full rounded px-2.5 transition-colors"
              :class="facetSort === option ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'"
              :aria-pressed="facetSort === option"
              @click="handleFacetSort(option)"
            >
              {{ t(`tagBrowser.tagOrder.${option}`) }}
            </button>
          </div>

          <button
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors"
            :class="groupByPrefix ? 'border-primary text-foreground' : 'border-border text-muted-foreground hover:text-foreground'"
            :aria-pressed="groupByPrefix"
            :title="t('tagBrowser.group.toggleHint')"
            @click="handleToggleGroupByPrefix"
          >
            <FolderTree :size="14" />
            {{ t('tagBrowser.group.toggle') }}
          </button>

          <button
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            :aria-expanded="panelsOpen"
            @click="handleTogglePanels"
          >
            <ChevronUp v-if="panelsOpen" :size="14" />
            <ChevronDown v-else :size="14" />
            {{ panelsOpen ? t('tagBrowser.panels.hide') : t('tagBrowser.panels.show') }}
          </button>

          <button
            v-if="hasActiveNarrowing"
            type="button"
            class="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            @click="handleReset"
          >
            <RotateCcw :size="14" />
            {{ t('tagBrowser.reset') }}
          </button>
        </div>

        <div v-if="filtersOpen" class="grid gap-4 rounded-lg border border-border bg-card p-4 lg:grid-cols-[2fr_1fr]">
          <div class="flex min-w-0 flex-col gap-2">
            <h2 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t('tagBrowser.filters.title') }}</h2>
            <p class="text-xs text-muted-foreground">{{ t('tagBrowser.filters.hint') }}</p>
            <BookFilterBuilder :model-value="extraFilter" @update:model-value="handleExtraFilter" />
          </div>
          <div class="flex min-w-0 flex-col gap-2">
            <h2 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t('tagBrowser.filters.sortTitle') }}</h2>
            <BookSortBuilder :model-value="sort" @update:model-value="handleSort" />
          </div>
        </div>

        <div
          v-if="!hasLibrarySelection"
          class="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground"
        >
          <FolderOpen :size="24" />
          <span>{{ libraries.length === 0 ? t('tagBrowser.libraries.none') : t('tagBrowser.libraries.noneSelected') }}</span>
        </div>

        <div v-else-if="panelsOpen" class="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6">
          <TagFacetPanel
            v-for="(panel, index) in panels"
            :key="panel.key"
            :index="index"
            :panel="panel"
            :request="facetRequests[index] ?? null"
            :max-selected="MAX_TAGS_PER_PANEL"
            :group-by-prefix="groupByPrefix"
            :can-exclude="canExcludeMore"
            @toggle="handleToggleTag(index, $event)"
            @exclude="handleExcludeTag"
            @inspect="handleInspectTag"
            @include-group="handleIncludeGroup(index, $event)"
            @exclude-group="handleExcludeGroup"
            @match="handlePanelMatch(index, $event)"
            @clear="handleClearPanel(index)"
          />
        </div>

        <TagSelectionBar
          v-if="hasLibrarySelection"
          :panels="panels"
          :excluded-tags="excludedTags"
          :total="total"
          :loading="loading"
          @remove-included="handleToggleTag"
          @remove-excluded="handleRemoveExcluded"
          @clear-excluded="handleClearExcluded"
        />

        <TagOverlapMatrix v-if="hasLibrarySelection && includedTags.length >= 2" :tags="includedTags" :scope="scope" @inspect="handleInspectTag" />

        <div v-if="error" class="flex items-center gap-2 text-sm text-destructive">
          <span>{{ t('tagBrowser.results.error') }}</span>
          <button type="button" class="text-foreground hover:underline" @click="handleRetry">{{ t('common.retry') }}</button>
        </div>

        <div v-if="showEmptyResults" class="py-12 text-center text-sm text-muted-foreground">
          {{ t('tagBrowser.results.empty') }}
        </div>

        <VirtualBookGrid
          v-if="hasLibrarySelection && slots.length > 0"
          :books="slots"
          :cover-size="coverSize"
          :grid-gap="gridGap"
          @range="handleRange"
          @action="handleBookAction"
          @update:book="updateBook"
        />
      </div>
    </div>

    <DeleteBookDialog :open="deleteBookId !== null" :deleting="deletingBook" @confirm="confirmDelete" @cancel="cancelDelete" />
    <AddToCollectionSheet
      :open="addToCollectionOpen"
      :selection-payload="collectionPayload"
      :selected-count="1"
      @update:open="handleCollectionOpen"
      @done="handleCollectionDone"
    />
    <TagInsightSheet
      :open="insightOpen"
      :tag="inspectedTag"
      :scope="scope"
      :included-tags="includedTags"
      :excluded-tags="excludedTags"
      :can-exclude="canExcludeMore"
      @update:open="handleInsightOpen"
      @inspect="handleInspectTag"
      @include="handleIncludeTag"
      @exclude="handleExcludeTag"
    />
  </section>
</template>
