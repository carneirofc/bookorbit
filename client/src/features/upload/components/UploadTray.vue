<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useElementSize } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, X } from '@lucide/vue'

import { useUploadQueue, type UploadItem } from '../composables/useUploadQueue'
import UploadTrayRow from './UploadTrayRow.vue'

/**
 * Large batches stay legible and cheap to render by showing the rows that are actually
 * moving plus a bounded tail, rather than every queued file.
 */
const MAX_VISIBLE_ROWS = 8

const { t } = useI18n()
const {
  items,
  trayOpen,
  trayDismissed,
  trayCollapsed: collapsed,
  trayHeight,
  activeCount,
  pendingCount,
  doneCount,
  errorCount,
  overallProgress,
  cancel,
  retry,
  remove,
  clearFinished,
} = useUploadQueue()

const trayEl = ref<HTMLElement | null>(null)
const { height } = useElementSize(trayEl, undefined, { box: 'border-box' })

const isVisible = computed(() => items.value.length > 0 && trayOpen.value && !trayDismissed.value)

const RANK: Record<UploadItem['status'], number> = { uploading: 0, finalizing: 0, pending: 1, error: 2, canceled: 3, done: 4 }
const ordered = computed(() => [...items.value].sort((a, b) => RANK[a.status] - RANK[b.status]))
const visibleItems = computed(() => ordered.value.slice(0, MAX_VISIBLE_ROWS))
const hiddenCount = computed(() => Math.max(0, ordered.value.length - MAX_VISIBLE_ROWS))

const heading = computed(() => {
  if (activeCount.value > 0) {
    return t('upload.tray.uploadingCount', { done: doneCount.value, total: items.value.length })
  }
  if (pendingCount.value > 0) return t('upload.tray.queuedCount', { count: pendingCount.value })
  if (errorCount.value > 0) return t('upload.tray.failedCount', { count: errorCount.value })
  return t('upload.tray.doneCount', { count: doneCount.value })
})

watch(
  [isVisible, height],
  ([visible, h]) => {
    trayHeight.value = visible ? Math.round(h) : 0
  },
  { immediate: true },
)

function toggleCollapsed() {
  collapsed.value = !collapsed.value
}

function handleDismiss() {
  clearFinished()
  trayDismissed.value = true
}

function handleCancel(id: string) {
  cancel(id)
}

function handleRetry(id: string) {
  retry(id)
}

function handleRemove(id: string) {
  remove(id)
}
</script>

<template>
  <div
    v-if="isVisible"
    ref="trayEl"
    class="fixed bottom-4 right-4 z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-card shadow-lg"
    role="status"
    aria-live="polite"
  >
    <div class="flex items-center gap-2 border-b border-border px-3 py-2">
      <p class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{{ heading }}</p>
      <span v-if="activeCount > 0" class="text-xs tabular-nums text-muted-foreground">{{ overallProgress }}%</span>

      <button
        type="button"
        class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        :aria-label="collapsed ? t('upload.tray.expand') : t('upload.tray.collapse')"
        @click="toggleCollapsed"
      >
        <ChevronUp v-if="collapsed" class="size-4" />
        <ChevronDown v-else class="size-4" />
      </button>

      <button
        type="button"
        class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        :aria-label="t('upload.tray.dismiss')"
        @click="handleDismiss"
      >
        <X class="size-4" />
      </button>
    </div>

    <div v-if="!collapsed" class="max-h-80 overflow-y-auto">
      <ul class="divide-y divide-border">
        <UploadTrayRow v-for="item in visibleItems" :key="item.id" :item="item" @cancel="handleCancel" @retry="handleRetry" @remove="handleRemove" />
      </ul>

      <p v-if="hiddenCount > 0" class="px-3 py-2 text-xs text-muted-foreground">
        {{ t('upload.tray.andMore', { count: hiddenCount }) }}
      </p>
    </div>
  </div>
</template>
