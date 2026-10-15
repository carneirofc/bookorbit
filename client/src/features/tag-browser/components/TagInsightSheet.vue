<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { Ban, Check, CirclePlus, RotateCw, Tag, Waypoints } from '@lucide/vue'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { formatNumber } from '@/i18n/formatters'
import { useTagInsight, type RelatedTag, type RelatedTagSort } from '../composables/useTagInsight'
import type { TagBrowserScope } from '../composables/useTagBrowser'

const props = defineProps<{
  open: boolean
  tag: string | null
  scope: TagBrowserScope | null
  includedTags: string[]
  excludedTags: string[]
  canExclude: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  inspect: [name: string]
  include: [name: string]
  exclude: [name: string]
}>()

const { t } = useI18n()

const sortBy = ref<RelatedTagSort>('together')
const sortOptions: RelatedTagSort[] = ['together', 'affinity']
const activeTag = computed(() => (props.open ? props.tag : null))
const { tagTotal, shareOfScope, relatedTags, loading, error, reload } = useTagInsight(activeTag, toRef(props, 'scope'), sortBy)

const tagIncluded = computed(() => (props.tag ? props.includedTags.includes(props.tag) : false))
const tagExcluded = computed(() => (props.tag ? props.excludedTags.includes(props.tag) : false))
const strongestAffinity = computed(() => Math.max(1, ...relatedTags.value.map((row) => row.affinity ?? 0)))

function percent(value: number | null): string {
  return value === null ? '-' : formatNumber(value, { style: 'percent', maximumFractionDigits: 0 })
}

function affinityLabel(row: RelatedTag): string {
  return row.affinity === null ? '-' : `×${formatNumber(row.affinity, { maximumFractionDigits: 1 })}`
}

function affinityClass(row: RelatedTag): string {
  if (row.affinity === null) return 'text-muted-foreground'
  if (row.affinity >= 2) return 'bg-primary/15 text-primary'
  if (row.affinity < 1) return 'text-muted-foreground'
  return 'text-foreground'
}

function barWidth(row: RelatedTag): string {
  const value = sortBy.value === 'affinity' ? (row.affinity ?? 0) / strongestAffinity.value : row.shareOfTag
  return `${Math.max(2, Math.round(value * 100))}%`
}

function isIncluded(name: string): boolean {
  return props.includedTags.includes(name)
}

function handleOpen(value: boolean) {
  emit('update:open', value)
}

function handleSort(value: RelatedTagSort) {
  sortBy.value = value
}

function handleIncludeCurrent() {
  if (props.tag) emit('include', props.tag)
}

function handleExcludeCurrent() {
  if (props.tag) emit('exclude', props.tag)
}

function handleInspect(name: string) {
  emit('inspect', name)
}

function handleInclude(name: string) {
  emit('include', name)
}

function handleExclude(name: string) {
  emit('exclude', name)
}

function handleRetry() {
  reload()
}
</script>

<template>
  <Sheet :open="open" @update:open="handleOpen">
    <SheetContent side="right" class="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
      <SheetHeader class="border-b border-border p-4">
        <SheetTitle class="flex items-center gap-2 pr-6">
          <Tag :size="16" class="shrink-0 text-muted-foreground" />
          <span class="truncate">{{ tag }}</span>
        </SheetTitle>
        <SheetDescription>
          {{ t('tagBrowser.insight.summary', { count: tagTotal, share: percent(shareOfScope) }) }}
        </SheetDescription>
        <div class="flex flex-wrap gap-2 pt-2">
          <button
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-sm transition-colors hover:bg-accent disabled:opacity-60"
            :disabled="tagIncluded"
            @click="handleIncludeCurrent"
          >
            <Check v-if="tagIncluded" :size="14" />
            <CirclePlus v-else :size="14" />
            {{ tagIncluded ? t('tagBrowser.insight.included') : t('tagBrowser.insight.include') }}
          </button>
          <button
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-md border border-destructive/30 px-3 text-sm text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-60"
            :disabled="tagExcluded || !canExclude"
            @click="handleExcludeCurrent"
          >
            <Ban :size="14" />
            {{ tagExcluded ? t('tagBrowser.insight.excluded') : t('tagBrowser.insight.exclude') }}
          </button>
        </div>
      </SheetHeader>

      <div class="flex items-center gap-2 px-4 pt-3 pb-2">
        <h3 class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Waypoints :size="13" />
          {{ t('tagBrowser.insight.relatedTitle') }}
        </h3>
        <div class="ml-auto inline-flex rounded-md border border-border p-0.5 text-xs" role="group" :aria-label="t('tagBrowser.insight.sortLabel')">
          <button
            v-for="option in sortOptions"
            :key="option"
            type="button"
            class="rounded px-2 py-0.5 transition-colors"
            :class="sortBy === option ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'"
            :aria-pressed="sortBy === option"
            @click="handleSort(option)"
          >
            {{ t(`tagBrowser.insight.sort.${option}`) }}
          </button>
        </div>
      </div>
      <p class="px-4 pb-2 text-xs text-muted-foreground">
        {{ sortBy === 'affinity' ? t('tagBrowser.insight.affinityHint') : t('tagBrowser.insight.togetherHint') }}
      </p>

      <div class="relative min-h-0 flex-1 overflow-y-auto px-2 pb-4" :class="loading ? 'opacity-60' : ''" :aria-busy="loading">
        <ul class="flex flex-col">
          <li v-for="row in relatedTags" :key="row.name" class="group rounded-md px-2 py-2 transition-colors hover:bg-accent">
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground hover:underline"
                :title="t('tagBrowser.row.related', { name: row.name })"
                @click="handleInspect(row.name)"
              >
                {{ row.name }}
              </button>
              <span class="shrink-0 rounded px-1.5 text-xs tabular-nums" :class="affinityClass(row)" :title="t('tagBrowser.insight.affinityTitle')">
                {{ affinityLabel(row) }}
              </span>
              <div class="flex shrink-0 items-center gap-0.5 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
                <button
                  type="button"
                  class="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-40"
                  :disabled="isIncluded(row.name)"
                  :title="t('tagBrowser.row.include', { name: row.name })"
                  :aria-label="t('tagBrowser.row.include', { name: row.name })"
                  @click="handleInclude(row.name)"
                >
                  <CirclePlus :size="13" />
                </button>
                <button
                  type="button"
                  class="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                  :disabled="!canExclude"
                  :title="t('tagBrowser.row.exclude', { name: row.name })"
                  :aria-label="t('tagBrowser.row.exclude', { name: row.name })"
                  @click="handleExclude(row.name)"
                >
                  <Ban :size="13" />
                </button>
              </div>
            </div>
            <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
              <div class="h-full rounded-full bg-primary/70" :style="{ width: barWidth(row) }" />
            </div>
            <div class="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground tabular-nums">
              <span>{{ t('tagBrowser.insight.together', { count: row.together }) }}</span>
              <span>{{ t('tagBrowser.insight.shareOfTag', { share: percent(row.shareOfTag), tag: tag ?? '' }) }}</span>
              <span v-if="row.shareOfRelated !== null">{{
                t('tagBrowser.insight.shareOfRelated', { share: percent(row.shareOfRelated), tag: row.name })
              }}</span>
            </div>
          </li>
        </ul>

        <p v-if="!loading && !error && relatedTags.length === 0" class="px-2 py-8 text-center text-sm text-muted-foreground">
          {{ t('tagBrowser.insight.noRelated') }}
        </p>
        <div v-if="error" class="flex flex-col items-center gap-2 px-2 py-8 text-center text-sm text-muted-foreground">
          <span>{{ t('tagBrowser.insight.error') }}</span>
          <button type="button" class="inline-flex items-center gap-1 text-foreground hover:underline" @click="handleRetry">
            <RotateCw :size="12" />
            {{ t('common.retry') }}
          </button>
        </div>
      </div>

      <p class="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">{{ t('tagBrowser.insight.scopeNote') }}</p>
    </SheetContent>
  </Sheet>
</template>
