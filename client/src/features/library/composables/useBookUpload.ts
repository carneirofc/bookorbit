import { computed, ref } from 'vue'
import type { UploadTarget } from '@bookorbit/types'
import { uploadViaSession } from '@/features/upload/uploadSession'
import { useAppInfo } from '@/features/settings/composables/useAppInfo'

export const SUPPORTED_FORMATS = ['epub', 'kepub', 'pdf', 'mobi', 'azw3', 'cbz', 'cbr', 'cb7', 'fb2', 'm4b', 'm4a', 'mp3', 'opus', 'ogg', 'flac']
export const SUPPORTED_FORMATS_ACCEPT = SUPPORTED_FORMATS.map((f) => `.${f}`).join(',')
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024 // 500 MB

export type FileUploadStatus = 'pending' | 'uploading' | 'done' | 'error'

export interface FileUploadItem {
  id: string
  file: File
  status: FileUploadStatus
  progress: number
  error?: string
  bookId?: number
  validationError?: boolean
}

const UPLOAD_CONCURRENCY = 3

function validateFile(file: File): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!SUPPORTED_FORMATS.includes(ext)) {
    return `Unsupported type .${ext}. Allowed: ${SUPPORTED_FORMATS.join(', ')}`
  }
  const { maxUploadSizeMb } = useAppInfo()
  const limitBytes = maxUploadSizeMb.value * 1024 * 1024
  if (file.size > limitBytes) {
    return `File exceeds the ${maxUploadSizeMb.value} MB limit`
  }
  return null
}

async function uploadSingle(item: FileUploadItem, target: UploadTarget): Promise<void> {
  item.status = 'uploading'
  item.progress = 0
  try {
    const session = await uploadViaSession({
      file: item.file,
      target,
      onProgress: (percent) => {
        item.progress = percent
      },
    })
    item.status = 'done'
    item.progress = 100
    item.bookId = session.bookId ?? undefined
  } catch (err) {
    item.status = 'error'
    item.error = err instanceof Error ? err.message : 'Upload failed'
  }
}

export function useBookUpload() {
  const files = ref<FileUploadItem[]>([])

  const pendingCount = computed(() => files.value.filter((f) => f.status === 'pending').length)
  const isUploading = computed(() => files.value.some((f) => f.status === 'uploading'))
  const doneCount = computed(() => files.value.filter((f) => f.status === 'done').length)
  const errorCount = computed(() => files.value.filter((f) => f.status === 'error').length)
  const uploadedBookIds = computed(() => files.value.filter((f) => f.bookId !== undefined).map((f) => f.bookId!))

  function addFiles(incoming: File[]) {
    for (const file of incoming) {
      // Skip duplicates already in the queue
      if (files.value.some((f) => f.file.name === file.name && f.file.size === file.size)) continue

      const error = validateFile(file) ?? undefined
      files.value.push({
        id: `${file.name}-${file.size}-${file.lastModified}`,
        file,
        status: error ? 'error' : 'pending',
        progress: 0,
        error,
        validationError: error !== undefined,
      })
    }
  }

  function removeFile(id: string) {
    files.value = files.value.filter((f) => f.id !== id)
  }

  function retryFile(id: string) {
    const item = files.value.find((f) => f.id === id)
    if (!item || item.status !== 'error' || item.validationError) return
    item.status = 'pending'
    item.error = undefined
    item.progress = 0
  }

  function reset() {
    files.value = []
  }

  async function startUpload(libraryId: number, folderId?: number) {
    const pending = files.value.filter((f) => f.status === 'pending')
    if (pending.length === 0) return

    const target: UploadTarget = { kind: 'library', libraryId, ...(folderId !== undefined ? { folderId } : {}) }

    // Process pending items with a concurrency limit of UPLOAD_CONCURRENCY
    let index = 0
    async function runNext(): Promise<void> {
      const item = pending[index++]
      if (!item) return
      await uploadSingle(item, target)
      await runNext()
    }

    const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, pending.length) }, () => runNext())
    await Promise.all(workers)
  }

  return {
    files,
    pendingCount,
    isUploading,
    doneCount,
    errorCount,
    uploadedBookIds,
    addFiles,
    removeFile,
    retryFile,
    reset,
    startUpload,
  }
}
