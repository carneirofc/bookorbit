<script setup lang="ts">
import { toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { Grid3x3, RotateCw } from '@lucide/vue'
import { formatNumber } from '@/i18n/formatters'
import { useTagOverlap, MAX_OVERLAP_TAGS } from '../composables/useTagOverlap'
import type { TagBrowserScope } from '../composables/useTagBrowser'

const props = defineProps<{
  tags: string[]
  scope: TagBrowserScope | null
}>()

const emit = defineEmits<{
  inspect: [name: string]
}>()

const { t } = useI18n()
const { overlap, loading, error, hiddenCount, reload } = useTagOverlap(toRef(props, 'tags'), toRef(props, 'scope'))

function pairCount(row: string, column: string): number {
  return overlap.value?.pairs[row]?.[column] ?? 0
}

function total(name: string): number {
  return overlap.value?.totals[name] ?? 0
}

/** Shade by Jaccard similarity so a pair of huge tags does not drown out a tight niche pairing. */
function similarity(row: string, column: string): number {
  const both = pairCount(row, column)
  const union = total(row) + total(column) - both
  return union > 0 ? both / union : 0
}

function cellStyle(row: string, column: string): Record<string, string> {
  if (row === column) return {}
  const strength = Math.round(similarity(row, column) * 100)
  return { backgroundColor: `color-mix(in oklch, var(--primary) ${Math.min(70, strength)}%, transparent)` }
}

function percent(part: number, whole: number): string {
  return formatNumber(whole > 0 ? part / whole : 0, { style: 'percent', maximumFractionDigits: 0 })
}

function cellTitle(row: string, column: string): string {
  if (row === column) return t('tagBrowser.overlap.diagonalTitle', { count: total(row), tag: row })
  const both = pairCount(row, column)
  return t('tagBrowser.overlap.cellTitle', {
    count: both,
    a: row,
    b: column,
    shareA: percent(both, total(row)),
    shareB: percent(both, total(column)),
  })
}

function handleInspect(name: string) {
  emit('inspect', name)
}

function handleRetry() {
  void reload()
}
</script>

<template>
  <section class="flex flex-col gap-2 rounded-lg border border-border bg-card p-4" :aria-busy="loading">
    <div class="flex flex-wrap items-center gap-2">
      <h2 class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Grid3x3 :size="13" />
        {{ t('tagBrowser.overlap.title') }}
      </h2>
      <span class="text-xs text-muted-foreground">{{ t('tagBrowser.overlap.hint') }}</span>
      <span v-if="hiddenCount > 0" class="text-xs text-muted-foreground">{{
        t('tagBrowser.overlap.hidden', { count: hiddenCount, max: MAX_OVERLAP_TAGS })
      }}</span>
    </div>

    <div v-if="error" class="flex items-center gap-2 text-sm text-muted-foreground">
      <span>{{ t('tagBrowser.overlap.error') }}</span>
      <button type="button" class="inline-flex items-center gap-1 text-foreground hover:underline" @click="handleRetry">
        <RotateCw :size="12" />
        {{ t('common.retry') }}
      </button>
    </div>

    <div v-else-if="overlap" class="overflow-x-auto transition-opacity" :class="loading ? 'opacity-60' : ''">
      <table class="border-separate border-spacing-1 text-xs">
        <thead>
          <tr>
            <th scope="col" class="sr-only">{{ t('tagBrowser.overlap.title') }}</th>
            <th
              v-for="column in overlap.tags"
              :key="column"
              scope="col"
              class="max-w-24 px-1 pb-1 text-left align-bottom font-medium text-muted-foreground"
            >
              <button
                type="button"
                class="block max-w-24 truncate hover:text-foreground hover:underline"
                :title="column"
                @click="handleInspect(column)"
              >
                {{ column }}
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in overlap.tags" :key="row">
            <th scope="row" class="max-w-36 pr-2 text-right font-medium text-muted-foreground">
              <button
                type="button"
                class="ml-auto block max-w-36 truncate hover:text-foreground hover:underline"
                :title="row"
                @click="handleInspect(row)"
              >
                {{ row }}
              </button>
            </th>
            <td
              v-for="column in overlap.tags"
              :key="column"
              class="h-9 min-w-14 rounded-md px-2 text-center tabular-nums"
              :class="row === column ? 'bg-muted font-semibold text-foreground' : 'text-foreground'"
              :style="cellStyle(row, column)"
              :title="cellTitle(row, column)"
            >
              {{ formatNumber(row === column ? total(row) : pairCount(row, column)) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="loading" class="h-24 animate-pulse rounded-md bg-muted" />
  </section>
</template>
