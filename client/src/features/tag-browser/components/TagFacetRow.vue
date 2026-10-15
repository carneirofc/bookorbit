<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Ban, Check, Waypoints } from '@lucide/vue'
import { formatNumber } from '@/i18n/formatters'

const props = defineProps<{
  name: string
  label?: string
  count: number
  selected: boolean
  disabled?: boolean
  canExclude: boolean
  indent?: boolean
}>()

const emit = defineEmits<{
  toggle: [name: string]
  exclude: [name: string]
  inspect: [name: string]
}>()

const { t } = useI18n()

function handleToggle() {
  emit('toggle', props.name)
}

function handleExclude() {
  emit('exclude', props.name)
}

function handleInspect() {
  emit('inspect', props.name)
}
</script>

<template>
  <div class="group flex items-center transition-colors hover:bg-accent" :class="selected ? 'bg-accent/60' : ''">
    <button
      type="button"
      role="option"
      :aria-selected="selected"
      :disabled="disabled"
      :title="name"
      class="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      :class="[indent ? 'pl-7' : 'pl-3', selected ? 'font-medium' : '']"
      @click="handleToggle"
    >
      <span
        class="flex size-3.5 shrink-0 items-center justify-center rounded-sm border border-border"
        :class="selected ? 'border-primary bg-primary text-primary-foreground' : ''"
      >
        <Check v-if="selected" :size="10" />
      </span>
      <span class="min-w-0 flex-1 truncate">{{ label ?? name }}</span>
      <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{{ formatNumber(count) }}</span>
    </button>
    <div class="flex shrink-0 items-center gap-0.5 pr-1.5 pl-1 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
      <button
        type="button"
        class="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        :title="t('tagBrowser.row.related', { name })"
        :aria-label="t('tagBrowser.row.related', { name })"
        @click="handleInspect"
      >
        <Waypoints :size="13" />
      </button>
      <button
        type="button"
        class="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
        :disabled="!canExclude"
        :title="t('tagBrowser.row.exclude', { name })"
        :aria-label="t('tagBrowser.row.exclude', { name })"
        @click="handleExclude"
      >
        <Ban :size="13" />
      </button>
    </div>
  </div>
</template>
