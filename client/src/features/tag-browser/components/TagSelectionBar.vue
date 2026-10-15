<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Ban, X } from '@lucide/vue'
import type { TagPanel } from '../composables/useTagBrowser'

const props = defineProps<{
  panels: TagPanel[]
  excludedTags: string[]
  total: number
  loading: boolean
}>()

const emit = defineEmits<{
  'remove-included': [panelIndex: number, name: string]
  'remove-excluded': [name: string]
  'clear-excluded': []
}>()

const { t } = useI18n()

const activePanels = computed(() => props.panels.map((panel, index) => ({ panel, index })).filter((entry) => entry.panel.selected.length > 0))

function handleRemoveIncluded(panelIndex: number, name: string) {
  emit('remove-included', panelIndex, name)
}

function handleRemoveExcluded(name: string) {
  emit('remove-excluded', name)
}

function handleClearExcluded() {
  emit('clear-excluded')
}
</script>

<template>
  <div class="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-sm" aria-live="polite">
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t('tagBrowser.selection.books') }}</span>
      <span v-if="activePanels.length === 0" class="text-muted-foreground">{{ t('tagBrowser.selection.anyTags') }}</span>
      <template v-for="(entry, position) in activePanels" :key="entry.panel.key">
        <span v-if="position > 0" class="px-0.5 text-[11px] font-semibold text-muted-foreground">{{ t('tagBrowser.selection.and') }}</span>
        <span class="inline-flex flex-wrap items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-1 py-0.5">
          <template v-for="(name, nameIndex) in entry.panel.selected" :key="name">
            <span v-if="nameIndex > 0" class="text-[10px] font-semibold uppercase text-muted-foreground">
              {{ entry.panel.match === 'all' ? t('tagBrowser.selection.and') : t('tagBrowser.selection.or') }}
            </span>
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground transition-opacity hover:opacity-80"
              :title="t('tagBrowser.panel.removeTag', { name })"
              @click="handleRemoveIncluded(entry.index, name)"
            >
              {{ name }}
              <X :size="11" />
            </button>
          </template>
        </span>
      </template>
      <span class="ml-auto text-xs tabular-nums text-muted-foreground transition-opacity" :class="loading ? 'opacity-50' : ''">
        {{ t('tagBrowser.selection.matching', { count: total }) }}
      </span>
    </div>

    <div v-if="excludedTags.length > 0" class="flex flex-wrap items-center gap-1.5">
      <span class="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-destructive">
        <Ban :size="12" />
        {{ t('tagBrowser.selection.without') }}
      </span>
      <button
        v-for="name in excludedTags"
        :key="name"
        type="button"
        class="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs text-destructive line-through decoration-destructive/40 transition-opacity hover:opacity-80"
        :title="t('tagBrowser.selection.removeExcluded', { name })"
        @click="handleRemoveExcluded(name)"
      >
        {{ name }}
        <X :size="11" />
      </button>
      <button type="button" class="text-xs text-muted-foreground hover:text-foreground hover:underline" @click="handleClearExcluded">
        {{ t('tagBrowser.selection.clearExcluded') }}
      </button>
    </div>
  </div>
</template>
