<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CheckCircle2, RotateCw, X, AlertCircle, Loader2 } from '@lucide/vue'

import type { UploadItem } from '../composables/useUploadQueue'
import { formatBytes, formatEta, formatSpeed } from '../utils/formatTransfer'

const { t } = useI18n()

const props = defineProps<{ item: UploadItem }>()
const emit = defineEmits<{ cancel: [id: string]; retry: [id: string]; remove: [id: string] }>()

const isActive = computed(() => props.item.status === 'uploading' || props.item.status === 'finalizing')
const isRetryable = computed(() => (props.item.status === 'error' || props.item.status === 'canceled') && !props.item.validationError)

const barClass = computed(() => {
  if (props.item.status === 'error') return 'bg-destructive'
  if (props.item.status === 'done') return 'bg-primary/60'
  return 'bg-primary'
})

const detail = computed(() => {
  const item = props.item

  if (item.status === 'error') return item.error ?? t('upload.tray.failed')
  if (item.status === 'canceled') return t('upload.tray.canceled')
  if (item.status === 'done') return formatBytes(item.file.size)
  if (item.status === 'pending') return t('upload.tray.queued')
  if (item.status === 'finalizing') return t('upload.tray.processing')

  const parts = [t('upload.tray.transferred', { loaded: formatBytes(item.loadedBytes), total: formatBytes(item.file.size) })]
  const speed = formatSpeed(item.speedBps)
  if (speed) parts.push(speed)
  const eta = formatEta(item.etaSeconds)
  if (eta) parts.push(t('upload.tray.remaining', { eta }))

  return parts.join(' · ')
})

function handleCancel() {
  emit('cancel', props.item.id)
}

function handleRetry() {
  emit('retry', props.item.id)
}

function handleRemove() {
  emit('remove', props.item.id)
}
</script>

<template>
  <li class="flex items-start gap-3 px-3 py-2">
    <div class="mt-0.5 shrink-0">
      <CheckCircle2 v-if="item.status === 'done'" class="size-4 text-primary" />
      <AlertCircle v-else-if="item.status === 'error'" class="size-4 text-destructive" />
      <Loader2 v-else-if="isActive" class="size-4 animate-spin text-muted-foreground" />
      <div v-else class="size-4 rounded-full border border-muted-foreground/30" />
    </div>

    <div class="min-w-0 flex-1">
      <p class="truncate text-sm text-foreground" :title="item.file.name">{{ item.file.name }}</p>

      <div v-if="isActive" class="mt-1 h-1 w-full overflow-hidden rounded-full bg-primary/10">
        <div class="h-full rounded-full transition-[width] duration-300 ease-out" :class="barClass" :style="{ width: `${item.progress}%` }" />
      </div>

      <p class="mt-1 truncate text-xs" :class="item.status === 'error' ? 'text-destructive' : 'text-muted-foreground'" :title="detail">
        {{ detail }}
      </p>
    </div>

    <div class="flex shrink-0 items-center gap-1">
      <span v-if="isActive" class="text-xs tabular-nums text-muted-foreground">{{ item.progress }}%</span>

      <button
        v-if="isRetryable"
        type="button"
        class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        :aria-label="t('upload.tray.retry')"
        :title="t('upload.tray.retry')"
        @click="handleRetry"
      >
        <RotateCw class="size-3.5" />
      </button>

      <button
        v-if="isActive"
        type="button"
        class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        :aria-label="t('upload.tray.cancel')"
        :title="t('upload.tray.cancel')"
        @click="handleCancel"
      >
        <X class="size-3.5" />
      </button>

      <button
        v-else
        type="button"
        class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        :aria-label="t('upload.tray.remove')"
        :title="t('upload.tray.remove')"
        @click="handleRemove"
      >
        <X class="size-3.5" />
      </button>
    </div>
  </li>
</template>
