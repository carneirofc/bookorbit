import { computed, ref, type ComputedRef, type Ref } from 'vue'

import { cancelChunkedUpload, newUploadId, uploadFileInChunks, UploadCanceledError, type ChunkUploadFailure } from './useChunkedUploader'

/** Files uploading at once. Each one also runs several chunks concurrently. */
const MAX_CONCURRENT_FILES = 3
/** Smoothing factor for the speed estimate; higher reacts faster and jitters more. */
const SPEED_SMOOTHING = 0.3
const SPEED_SAMPLE_INTERVAL_MS = 500

export type UploadItemStatus = 'pending' | 'uploading' | 'finalizing' | 'done' | 'error' | 'canceled'

export interface UploadItem<TResult = unknown> {
  id: string
  uploadId: string
  file: File
  status: UploadItemStatus
  /** 0-100, derived from bytes actually acknowledged by the transport. */
  progress: number
  loadedBytes: number
  /** Bytes per second, or null before there is enough signal to estimate. */
  speedBps: number | null
  /** Seconds remaining, or null when unknown. */
  etaSeconds: number | null
  error?: string
  errorCode?: string
  /** Set when the failure came from validation, which no retry can fix. */
  validationError?: boolean
  result?: TResult
}

export interface UploadTarget<TResult = unknown> {
  /** Endpoint that accepts the multipart chunks. */
  url: string
  /** Base path for cancelation, e.g. `/api/v1/book-dock/upload`. */
  cancelUrl: string
  /** Read per upload, since the server-advertised size may arrive after this target is built. */
  chunkSizeBytes?: () => number | undefined
  validate: (file: File) => string | null
  onFileDone?: (item: UploadItem<TResult>) => void
}

export interface AddFilesOptions {
  /**
   * Leave files parked in the queue instead of starting them. Used where the destination
   * is chosen after the files are picked, as in the library upload modal.
   */
  hold?: boolean
}

/** Everything the queue tracks that callers have no business seeing. */
interface QueueEntry {
  item: UploadItem
  target: UploadTarget
  ready: boolean
  controller: AbortController | null
  lastSampleAt: number
  lastSampleBytes: number
  settled: Promise<void>
  markSettled: () => void
}

/**
 * A single queue shared by every upload surface in the app.
 *
 * Module-level state on purpose: uploads must survive route changes, and the tray needs
 * to show them wherever the user navigates. Each entry carries its own target, so two
 * surfaces uploading to different endpoints cannot cross wires.
 */
const items = ref<UploadItem[]>([])
const entries = new Map<string, QueueEntry>()
const trayOpen = ref(false)
const trayDismissed = ref(false)

let draining = false

export interface UploadQueue<TResult> {
  items: Ref<UploadItem[]>
  files: ComputedRef<UploadItem<TResult>[]>
  trayOpen: Ref<boolean>
  trayDismissed: Ref<boolean>
  activeCount: ComputedRef<number>
  pendingCount: ComputedRef<number>
  doneCount: ComputedRef<number>
  errorCount: ComputedRef<number>
  isUploading: ComputedRef<boolean>
  overallProgress: ComputedRef<number>
  addFiles: (incoming: Iterable<File>, options?: AddFilesOptions) => string[]
  release: (ids: string[], overrides?: Partial<UploadTarget<TResult>>) => Promise<void>
  retry: (id: string) => void
  cancel: (id: string) => void
  remove: (id: string) => void
  clearFinished: () => void
  clearAll: () => void
}

export function useUploadQueue<TResult = unknown>(target?: UploadTarget<TResult>): UploadQueue<TResult> {
  const activeCount = computed(() => items.value.filter((i) => i.status === 'uploading' || i.status === 'finalizing').length)
  const pendingCount = computed(() => items.value.filter((i) => i.status === 'pending').length)
  const doneCount = computed(() => items.value.filter((i) => i.status === 'done').length)
  const errorCount = computed(() => items.value.filter((i) => i.status === 'error').length)
  const isUploading = computed(() => activeCount.value > 0 || pendingCount.value > 0)

  const totalBytes = computed(() => items.value.reduce((sum, i) => sum + i.file.size, 0))
  const loadedBytes = computed(() => items.value.reduce((sum, i) => sum + i.loadedBytes, 0))
  const overallProgress = computed(() => (totalBytes.value === 0 ? 0 : Math.round((loadedBytes.value / totalBytes.value) * 100)))

  const files = computed(() => items.value as UploadItem<TResult>[])

  function requireTarget(): UploadTarget<TResult> {
    if (!target) throw new Error('useUploadQueue needs an upload target to enqueue files')
    return target
  }

  function addFiles(incoming: Iterable<File>, options: AddFilesOptions = {}): string[] {
    const active = requireTarget()
    const added: string[] = []

    for (const file of incoming) {
      const error = active.validate(file) ?? undefined
      const id = `${file.name}-${file.size}-${file.lastModified}-${newUploadId().slice(0, 8)}`

      const item: UploadItem = {
        id,
        uploadId: newUploadId(),
        file,
        status: error ? 'error' : 'pending',
        progress: 0,
        loadedBytes: 0,
        speedBps: null,
        etaSeconds: null,
        error,
        validationError: error !== undefined,
      }

      let markSettled = () => {}
      const settled = new Promise<void>((resolve) => {
        markSettled = resolve
      })
      if (error) markSettled()

      entries.set(id, {
        item,
        target: active as UploadTarget,
        ready: !options.hold && !error,
        controller: null,
        lastSampleAt: 0,
        lastSampleBytes: 0,
        settled,
        markSettled,
      })

      items.value.push(item)
      added.push(id)
    }

    if (!options.hold) {
      trayDismissed.value = false
      trayOpen.value = true
      void drain()
    }

    return added
  }

  /** Starts held files, optionally rebinding them to a target now that it is known. */
  async function release(ids: string[], overrides?: Partial<UploadTarget<TResult>>): Promise<void> {
    const released: QueueEntry[] = []

    for (const id of ids) {
      const entry = entries.get(id)
      if (!entry || entry.item.status !== 'pending') continue
      if (overrides) entry.target = { ...entry.target, ...overrides } as UploadTarget
      entry.ready = true
      released.push(entry)
    }

    if (released.length === 0) return

    trayDismissed.value = false
    trayOpen.value = true
    void drain()

    await Promise.all(released.map((entry) => entry.settled))
  }

  function retry(id: string): void {
    const entry = entries.get(id)
    if (!entry || entry.item.validationError) return
    if (entry.item.status !== 'error' && entry.item.status !== 'canceled') return

    // A fresh id: the previous server-side session is dead or unusable.
    Object.assign(entry.item, {
      uploadId: newUploadId(),
      status: 'pending' as const,
      progress: 0,
      loadedBytes: 0,
      speedBps: null,
      etaSeconds: null,
      error: undefined,
      errorCode: undefined,
    })

    const settled = new Promise<void>((resolve) => {
      entry.markSettled = resolve
    })
    entry.settled = settled
    entry.ready = true

    void drain()
  }

  function cancel(id: string): void {
    const entry = entries.get(id)
    if (!entry) return

    entry.controller?.abort()
    entry.ready = false
    if (entry.item.status === 'pending') {
      entry.item.status = 'canceled'
      entry.markSettled()
    }

    void cancelChunkedUpload(entry.target.cancelUrl, entry.item.uploadId)
  }

  function remove(id: string): void {
    cancel(id)
    entries.delete(id)
    items.value = items.value.filter((i) => i.id !== id)
  }

  function clearFinished(): void {
    for (const item of items.value) {
      if (item.status === 'done' || item.status === 'canceled') entries.delete(item.id)
    }
    items.value = items.value.filter((i) => i.status !== 'done' && i.status !== 'canceled')
  }

  function clearAll(): void {
    const current = items.value
    items.value = []
    for (const item of current) cancel(item.id)
    entries.clear()
  }

  return {
    items,
    files,
    trayOpen,
    trayDismissed,
    activeCount,
    pendingCount,
    doneCount,
    errorCount,
    isUploading,
    overallProgress,
    addFiles,
    release,
    retry,
    cancel,
    remove,
    clearFinished,
    clearAll,
  }
}

function updateSpeed(entry: QueueEntry, now: number): void {
  const { item } = entry
  const elapsedMs = now - entry.lastSampleAt
  if (elapsedMs < SPEED_SAMPLE_INTERVAL_MS) return

  const sample = ((item.loadedBytes - entry.lastSampleBytes) * 1000) / elapsedMs
  entry.lastSampleAt = now
  entry.lastSampleBytes = item.loadedBytes

  if (sample < 0) return
  item.speedBps = item.speedBps === null ? sample : item.speedBps * (1 - SPEED_SMOOTHING) + sample * SPEED_SMOOTHING
  item.etaSeconds = item.speedBps > 0 ? Math.max(0, Math.round((item.file.size - item.loadedBytes) / item.speedBps)) : null
}

async function runEntry(entry: QueueEntry): Promise<void> {
  const { item, target } = entry
  const controller = new AbortController()

  entry.controller = controller
  entry.lastSampleAt = Date.now()
  entry.lastSampleBytes = 0
  item.status = 'uploading'

  try {
    const result = await uploadFileInChunks({
      file: item.file,
      url: target.url,
      uploadId: item.uploadId,
      chunkSizeBytes: target.chunkSizeBytes?.(),
      signal: controller.signal,
      onProgress: ({ loadedBytes, totalBytes }) => {
        item.loadedBytes = loadedBytes
        item.progress = totalBytes === 0 ? 100 : Math.min(100, Math.round((loadedBytes / totalBytes) * 100))
        updateSpeed(entry, Date.now())
      },
      onFinalizing: () => {
        if (item.status === 'uploading') item.status = 'finalizing'
      },
    })

    item.status = 'done'
    item.progress = 100
    item.loadedBytes = item.file.size
    item.result = result
    target.onFileDone?.(item)
  } catch (err) {
    if (err instanceof UploadCanceledError) {
      item.status = 'canceled'
    } else {
      const failure = err as ChunkUploadFailure
      item.status = 'error'
      item.error = failure?.message ?? 'Upload failed'
      item.errorCode = failure?.errorCode
    }
  } finally {
    item.speedBps = null
    item.etaSeconds = null
    entry.controller = null
    entry.ready = false
    entry.markSettled()
  }
}

/**
 * Keeps `MAX_CONCURRENT_FILES` uploads running, refilling a slot the moment one frees up
 * rather than waiting for a whole batch to finish.
 */
async function drain(): Promise<void> {
  if (draining) return
  draining = true

  try {
    const running = new Set<Promise<void>>()

    while (true) {
      while (running.size < MAX_CONCURRENT_FILES) {
        const next = [...entries.values()].find((e) => e.ready && e.item.status === 'pending')
        if (!next) break
        const promise = runEntry(next).finally(() => running.delete(promise))
        running.add(promise)
      }

      if (running.size === 0) break
      await Promise.race(running)
    }
  } finally {
    draining = false
  }
}
