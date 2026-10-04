<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { AlertTriangle, CheckCircle2, Download, Loader2, Package, X } from '@lucide/vue'
import { BOOK_EXPORT_PART_SIZES_MB, type BookExportPartSizeMb, type BookExportScope } from '@bookorbit/types'
import { useBulkDownload } from '@/features/book/composables/useBulkDownload'
import { formatBytes } from '@/lib/formatting'
import { formatNumber } from '@/i18n/formatters'

const { t } = useI18n()
const {
  open,
  scope,
  partSizeMb,
  session,
  startedParts,
  preparing,
  error,
  activeParts,
  atCapacity,
  nextPartIndex,
  prepare,
  downloadPart,
  downloadNextPart,
  close,
} = useBulkDownload()

const SCOPES: BookExportScope[] = ['primary', 'all', 'audio']

const scopeLabels = computed<Record<BookExportScope, string>>(() => ({
  primary: t('book.bulkDownload.scopePrimary'),
  all: t('book.bulkDownload.scopeAll'),
  audio: t('book.bulkDownload.scopeAudio'),
}))

const errorMessage = computed(() => (error.value === null ? null : error.value || t('book.bulkDownload.prepareFailed')))
const allStarted = computed(() => !!session.value && nextPartIndex.value === null)

function partButtonLabel(index: number): string {
  if (activeParts.value.has(index)) return t('book.bulkDownload.downloading')
  return startedParts.value.has(index) ? t('book.bulkDownload.downloadAgain') : t('book.bulkDownload.download')
}

function partSizeLabel(sizeMb: BookExportPartSizeMb): string {
  return formatBytes(sizeMb * 1024 * 1024)
}

function partLabel(index: number): string {
  return t('book.bulkDownload.partLabel', { index: index + 1, total: session.value?.parts.length ?? 0 })
}

function handleScopeChange(event: Event) {
  scope.value = (event.target as HTMLSelectElement).value as BookExportScope
  void prepare()
}

function handlePartSizeChange(event: Event) {
  partSizeMb.value = Number((event.target as HTMLSelectElement).value) as BookExportPartSizeMb
  void prepare()
}

function handleDownloadNext() {
  void downloadNextPart()
}

function handleOpenChange(value: boolean) {
  if (!value) close()
}

function handleClose() {
  close()
}
</script>

<template>
  <DialogRoot :open="open" @update:open="handleOpenChange">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-scrim backdrop-blur-sm" />
      <DialogContent
        aria-modal="true"
        class="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-card shadow-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="bulk-download-dialog"
      >
        <div class="flex items-center justify-between border-b border-border px-5 py-4">
          <div class="flex items-center gap-2">
            <Package :size="16" class="text-primary" aria-hidden="true" />
            <DialogTitle class="text-base font-semibold text-foreground">{{ t('book.bulkDownload.title') }}</DialogTitle>
          </div>
          <button
            class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            :aria-label="t('common.close')"
            @click="handleClose"
          >
            <X :size="14" />
          </button>
        </div>

        <div class="space-y-4 overflow-hidden px-5 py-4">
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="space-y-1 text-sm">
              <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t('book.bulkDownload.filesLabel') }}</span>
              <select
                class="w-full rounded-md border border-input bg-background px-2 py-1.5 text-foreground"
                :value="scope"
                :disabled="preparing"
                data-testid="bulk-download-scope"
                @change="handleScopeChange"
              >
                <option v-for="option in SCOPES" :key="option" :value="option">{{ scopeLabels[option] }}</option>
              </select>
            </label>
            <label class="space-y-1 text-sm">
              <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t('book.bulkDownload.partSizeLabel') }}</span>
              <select
                class="w-full rounded-md border border-input bg-background px-2 py-1.5 text-foreground"
                :value="partSizeMb"
                :disabled="preparing"
                data-testid="bulk-download-part-size"
                @change="handlePartSizeChange"
              >
                <option v-for="size in BOOK_EXPORT_PART_SIZES_MB" :key="size" :value="size">{{ partSizeLabel(size) }}</option>
              </select>
            </label>
          </div>
          <DialogDescription class="text-xs text-muted-foreground">{{ t('book.bulkDownload.partSizeHint') }}</DialogDescription>

          <p v-if="preparing" class="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 :size="14" class="animate-spin" /> {{ t('book.bulkDownload.preparing') }}
          </p>
          <p v-else-if="errorMessage" class="text-sm text-destructive">{{ errorMessage }}</p>

          <template v-else-if="session">
            <div class="rounded-md border border-border/70 bg-muted/30 p-3 text-sm" data-testid="bulk-download-summary">
              <p class="font-medium text-foreground">
                {{
                  t('book.bulkDownload.summary', {
                    books: session.bookCount,
                    booksLabel: formatNumber(session.bookCount),
                    parts: session.parts.length,
                    size: formatBytes(session.totalBytes),
                  })
                }}
              </p>
              <p v-if="session.skippedBookCount > 0" class="mt-1 text-muted-foreground">
                {{ t('book.bulkDownload.skipped', { count: session.skippedBookCount }) }}
              </p>
              <p class="mt-1 text-muted-foreground">
                {{ t('book.bulkDownload.clickEachPart', { count: session.maxConcurrentExports }) }}
              </p>
            </div>
            <p v-if="atCapacity" class="text-sm text-muted-foreground" role="status" data-testid="bulk-download-at-capacity">
              {{ t('book.bulkDownload.atCapacity', { count: session.maxConcurrentExports }) }}
            </p>

            <ul class="max-h-72 space-y-1 overflow-y-auto pr-1" data-testid="bulk-download-parts">
              <li
                v-for="part in session.parts"
                :key="part.index"
                class="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm"
              >
                <div class="min-w-0">
                  <p class="flex items-center gap-1.5 font-medium text-foreground">
                    <Loader2 v-if="activeParts.has(part.index)" :size="14" class="shrink-0 animate-spin text-primary" aria-hidden="true" />
                    <CheckCircle2 v-else-if="startedParts.has(part.index)" :size="14" class="shrink-0 text-primary" aria-hidden="true" />
                    {{ partLabel(part.index) }}
                  </p>
                  <p class="truncate text-xs text-muted-foreground">
                    {{ t('book.bulkDownload.partDetails', { count: part.bookCount, size: formatBytes(part.bytes) }) }}
                  </p>
                  <p v-if="part.oversized" class="flex items-center gap-1 text-xs text-muted-foreground">
                    <AlertTriangle :size="12" class="shrink-0" /> {{ t('book.bulkDownload.oversized') }}
                  </p>
                </div>
                <button
                  class="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-input px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                  :disabled="preparing || atCapacity || activeParts.has(part.index)"
                  :data-testid="`bulk-download-part-${part.index}`"
                  @click="downloadPart(part.index)"
                >
                  <Download :size="12" aria-hidden="true" />
                  {{ partButtonLabel(part.index) }}
                </button>
              </li>
            </ul>
          </template>
        </div>

        <div class="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
          <button
            class="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            @click="handleClose"
          >
            {{ allStarted ? t('book.bulkDownload.done') : t('common.cancel') }}
          </button>
          <button
            class="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            :disabled="!session || preparing || atCapacity || nextPartIndex === null"
            data-testid="bulk-download-next"
            @click="handleDownloadNext"
          >
            <Download :size="14" />
            {{ nextPartIndex === null ? t('book.bulkDownload.allStarted') : t('book.bulkDownload.downloadNext', { part: partLabel(nextPartIndex) }) }}
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
