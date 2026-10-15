<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { refDebounced } from '@vueuse/core'
import { Ban, ChevronRight, CirclePlus, RotateCw, Search, X } from '@lucide/vue'
import type { TagFacetsQuery } from '@bookorbit/types'
import { formatNumber } from '@/i18n/formatters'
import { useTagFacets } from '../composables/useTagFacets'
import type { TagPanel } from '../composables/useTagBrowser'
import type { TagMatchMode } from '../lib/tag-browser-filter'
import { groupTagsByPrefix, type TagPrefixGroup } from '../lib/tag-prefix-groups'
import TagFacetRow from './TagFacetRow.vue'

const props = defineProps<{
  index: number
  panel: TagPanel
  request: TagFacetsQuery | null
  maxSelected: number
  groupByPrefix: boolean
  canExclude: boolean
}>()

const emit = defineEmits<{
  toggle: [name: string]
  exclude: [name: string]
  inspect: [name: string]
  'include-group': [names: string[]]
  'exclude-group': [names: string[]]
  match: [mode: TagMatchMode]
  clear: []
}>()

const { t } = useI18n()

const search = ref('')
const debouncedSearch = refDebounced(search, 250)
const expandedGroups = ref(new Set<string>())

const facetRequest = computed<TagFacetsQuery | null>(() => {
  if (!props.request) return null
  const tagSearch = debouncedSearch.value.trim()
  return tagSearch ? { ...props.request, tagSearch } : props.request
})

const { tags, totalBooks, truncated, loading, error, reload } = useTagFacets(facetRequest)

const grouped = computed(() => (props.groupByPrefix ? groupTagsByPrefix(tags.value) : { groups: [], ungrouped: tags.value }))
const selectedSet = computed(() => new Set(props.panel.selected))
const atSelectionLimit = computed(() => props.panel.selected.length >= props.maxSelected)
const showMatchToggle = computed(() => props.panel.selected.length > 1)
const isEmpty = computed(() => !loading.value && !error.value && tags.value.length === 0)
const searching = computed(() => debouncedSearch.value.trim().length > 0)

function isSelected(name: string): boolean {
  return selectedSet.value.has(name)
}

function isExpanded(group: TagPrefixGroup): boolean {
  return searching.value || expandedGroups.value.has(group.prefix)
}

function groupSelectedCount(group: TagPrefixGroup): number {
  return group.tags.filter((member) => isSelected(member.facet.name)).length
}

function groupNames(group: TagPrefixGroup): string[] {
  return group.tags.map((member) => member.facet.name)
}

function handleToggleGroup(group: TagPrefixGroup) {
  const next = new Set(expandedGroups.value)
  if (next.has(group.prefix)) next.delete(group.prefix)
  else next.add(group.prefix)
  expandedGroups.value = next
}

function handleIncludeGroup(group: TagPrefixGroup) {
  emit('include-group', groupNames(group))
}

function handleExcludeGroup(group: TagPrefixGroup) {
  emit('exclude-group', groupNames(group))
}

function handleToggle(name: string) {
  emit('toggle', name)
}

function handleExclude(name: string) {
  emit('exclude', name)
}

function handleInspect(name: string) {
  emit('inspect', name)
}

function handleMatchAny() {
  emit('match', 'any')
}

function handleMatchAll() {
  emit('match', 'all')
}

function handleClear() {
  emit('clear')
}

function handleClearSearch() {
  search.value = ''
}

function handleRetry() {
  void reload()
}
</script>

<template>
  <section
    class="flex h-96 w-[85vw] max-w-80 shrink-0 snap-start flex-col overflow-hidden rounded-lg border border-border bg-card sm:w-80"
    :aria-label="t('tagBrowser.panel.title', { index: index + 1 })"
  >
    <header class="flex items-center gap-2 border-b border-border px-3 py-2">
      <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {{ t('tagBrowser.panel.title', { index: index + 1 }) }}
      </span>
      <span class="ml-auto text-xs tabular-nums text-muted-foreground">
        {{ t('tagBrowser.panel.books', { count: totalBooks }) }}
      </span>
    </header>

    <div class="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
      <Search :size="13" class="shrink-0 text-muted-foreground" />
      <input
        v-model="search"
        type="search"
        :placeholder="t('tagBrowser.panel.searchPlaceholder')"
        :aria-label="t('tagBrowser.panel.searchPlaceholder')"
        class="h-6 w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      <button
        v-if="search"
        type="button"
        class="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        :aria-label="t('tagBrowser.panel.clearSearch')"
        @click="handleClearSearch"
      >
        <X :size="12" />
      </button>
    </div>

    <div v-if="panel.selected.length > 0" class="flex flex-col gap-1.5 border-b border-border px-2.5 py-2">
      <div class="flex max-h-20 flex-wrap gap-1 overflow-y-auto">
        <button
          v-for="name in panel.selected"
          :key="name"
          type="button"
          class="inline-flex max-w-full items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground transition-opacity hover:opacity-80"
          :title="t('tagBrowser.panel.removeTag', { name })"
          @click="handleToggle(name)"
        >
          <span class="truncate">{{ name }}</span>
          <X :size="11" class="shrink-0" />
        </button>
      </div>
      <div class="flex items-center gap-2">
        <div
          v-if="showMatchToggle"
          class="inline-flex rounded-md border border-border p-0.5 text-xs"
          role="group"
          :aria-label="t('tagBrowser.panel.matchLabel')"
        >
          <button
            type="button"
            class="rounded px-2 py-0.5 transition-colors"
            :class="panel.match === 'any' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'"
            :aria-pressed="panel.match === 'any'"
            :title="t('tagBrowser.panel.matchAnyHint')"
            @click="handleMatchAny"
          >
            {{ t('tagBrowser.panel.matchAny') }}
          </button>
          <button
            type="button"
            class="rounded px-2 py-0.5 transition-colors"
            :class="panel.match === 'all' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'"
            :aria-pressed="panel.match === 'all'"
            :title="t('tagBrowser.panel.matchAllHint')"
            @click="handleMatchAll"
          >
            {{ t('tagBrowser.panel.matchAll') }}
          </button>
        </div>
        <button type="button" class="ml-auto text-xs text-muted-foreground transition-colors hover:text-foreground" @click="handleClear">
          {{ t('tagBrowser.panel.clear') }}
        </button>
      </div>
    </div>

    <div class="relative min-h-0 flex-1">
      <div
        class="h-full overflow-y-auto py-1 transition-opacity"
        :class="loading ? 'opacity-60' : ''"
        role="listbox"
        aria-multiselectable="true"
        :aria-busy="loading"
        :aria-label="t('tagBrowser.panel.title', { index: index + 1 })"
      >
        <div v-for="group in grouped.groups" :key="`group:${group.prefix}`" role="group" :aria-label="group.prefix">
          <div class="group flex items-center border-b border-border/50 bg-muted/40 transition-colors hover:bg-accent">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2 text-left text-sm font-medium text-foreground"
              :aria-expanded="isExpanded(group)"
              @click="handleToggleGroup(group)"
            >
              <ChevronRight :size="14" class="shrink-0 text-muted-foreground transition-transform" :class="isExpanded(group) ? 'rotate-90' : ''" />
              <span class="min-w-0 flex-1 truncate">{{ group.prefix }}</span>
              <span
                v-if="groupSelectedCount(group) > 0"
                class="shrink-0 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground tabular-nums"
              >
                {{ groupSelectedCount(group) }}
              </span>
              <span class="shrink-0 text-xs font-normal text-muted-foreground">{{ t('tagBrowser.group.tags', { count: group.tags.length }) }}</span>
            </button>
            <div class="flex shrink-0 items-center gap-0.5 pr-1.5 pl-1 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
              <button
                type="button"
                class="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                :title="t('tagBrowser.group.includeAll', { prefix: group.prefix })"
                :aria-label="t('tagBrowser.group.includeAll', { prefix: group.prefix })"
                @click="handleIncludeGroup(group)"
              >
                <CirclePlus :size="13" />
              </button>
              <button
                type="button"
                class="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
                :disabled="!canExclude"
                :title="t('tagBrowser.group.excludeAll', { prefix: group.prefix })"
                :aria-label="t('tagBrowser.group.excludeAll', { prefix: group.prefix })"
                @click="handleExcludeGroup(group)"
              >
                <Ban :size="13" />
              </button>
            </div>
          </div>
          <template v-if="isExpanded(group)">
            <TagFacetRow
              v-for="member in group.tags"
              :key="member.facet.id"
              :name="member.facet.name"
              :label="member.label"
              :count="member.facet.count"
              :selected="isSelected(member.facet.name)"
              :disabled="!isSelected(member.facet.name) && atSelectionLimit"
              :can-exclude="canExclude"
              indent
              @toggle="handleToggle"
              @exclude="handleExclude"
              @inspect="handleInspect"
            />
          </template>
        </div>

        <div
          v-if="grouped.groups.length > 0 && grouped.ungrouped.length > 0"
          class="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {{ t('tagBrowser.group.other') }}
        </div>
        <TagFacetRow
          v-for="tag in grouped.ungrouped"
          :key="tag.id"
          :name="tag.name"
          :count="tag.count"
          :selected="isSelected(tag.name)"
          :disabled="!isSelected(tag.name) && atSelectionLimit"
          :can-exclude="canExclude"
          @toggle="handleToggle"
          @exclude="handleExclude"
          @inspect="handleInspect"
        />
      </div>

      <div v-if="isEmpty" class="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted-foreground">
        {{ search ? t('tagBrowser.panel.noMatches') : t('tagBrowser.panel.empty') }}
      </div>
      <div
        v-if="error"
        class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-card p-4 text-center text-xs text-muted-foreground"
      >
        <span>{{ t('tagBrowser.panel.error') }}</span>
        <button type="button" class="inline-flex items-center gap-1 text-foreground hover:underline" @click="handleRetry">
          <RotateCw :size="12" />
          {{ t('common.retry') }}
        </button>
      </div>
    </div>

    <footer v-if="truncated || atSelectionLimit" class="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
      {{
        atSelectionLimit
          ? t('tagBrowser.panel.selectionLimit', { count: maxSelected })
          : t('tagBrowser.panel.truncated', { count: formatNumber(tags.length) })
      }}
    </footer>
  </section>
</template>
