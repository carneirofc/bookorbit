<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check } from '@lucide/vue'
import type { Library } from '@bookorbit/types'
import AppIcon from '@/components/AppIcon.vue'

const props = defineProps<{
  libraries: Library[]
  isSelected: (id: number) => boolean
  selectedCount: number
}>()

const emit = defineEmits<{
  toggle: [id: number]
  'select-all': []
}>()

const { t } = useI18n()

const allSelected = computed(() => props.selectedCount === props.libraries.length)

function handleToggle(id: number) {
  emit('toggle', id)
}

function handleSelectAll() {
  emit('select-all')
}
</script>

<template>
  <div class="flex flex-col gap-2" role="group" :aria-label="t('tagBrowser.libraries.label')">
    <div class="flex items-center gap-2 text-xs text-muted-foreground">
      <span class="font-semibold uppercase tracking-wide">{{ t('tagBrowser.libraries.label') }}</span>
      <span class="tabular-nums">{{ t('tagBrowser.libraries.selected', { selected: selectedCount, total: libraries.length }) }}</span>
      <button v-if="!allSelected" type="button" class="ml-1 text-foreground hover:underline" @click="handleSelectAll">
        {{ t('tagBrowser.libraries.selectAll') }}
      </button>
    </div>
    <div class="flex flex-wrap gap-1.5">
      <button
        v-for="library in libraries"
        :key="library.id"
        type="button"
        class="inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors"
        :class="
          isSelected(library.id)
            ? 'border-primary bg-primary/10 text-foreground'
            : 'border-border bg-background text-muted-foreground hover:text-foreground'
        "
        :aria-pressed="isSelected(library.id)"
        @click="handleToggle(library.id)"
      >
        <Check v-if="isSelected(library.id)" :size="13" class="shrink-0 text-primary" />
        <AppIcon v-else :icon="library.icon" fallback="Library" :size="13" class="shrink-0" />
        <span class="truncate">{{ library.name }}</span>
      </button>
    </div>
  </div>
</template>
