import { computed, ref } from 'vue'
import { getValidToken } from '@/lib/api'
import { uploadViaSession } from '@/features/upload/uploadSession'
import { useAppInfo } from '@/features/settings/composables/useAppInfo'

export const SUPPORTED_FORMATS = ['epub', 'kepub', 'pdf', 'mobi', 'azw3', 'cbz', 'cbr', 'cb7', 'fb2', 'm4b', 'm4a', 'mp3', 'opus', 'ogg', 'flac']
export const SUPPORTED_FORMATS_ACCEPT = SUPPORTED_FORMATS.map((f) => `.${f}`).join(',')
export const MAX_FILE_BYTES = 500 * 1024 * 1024

export type FileUploadStatus = 'pending' | 'uploading' | 'done' | 'error'

export interface BookFileUploadItem {
  id: string
  file: File
  status: FileUploadStatus
  progress: number
  error?: string
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

async function uploadSingle(item: BookFileUploadItem, bookId: number): Promise<void> {
  item.status = 'uploading'
  item.progress = 0
  try {
    await uploadViaSession({
      file: item.file,
      target: { kind: 'existing_book', bookId },
      onProgress: (percent) => {
        item.progress = percent
      },
    })
    item.status = 'done'
    item.progress = 100
  } catch (err) {
    item.status = 'error'
    item.error = err instanceof Error ? err.message : 'Upload failed'
  }
}

async function triggerRename(bookId: number): Promise<void> {
  const token = await getValidToken()
  await fetch(`/api/v1/books/${bookId}/rename-files`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).catch(() => {
    // Best-effort — rename failure does not invalidate completed uploads
  })
}

export function useAddBookFile() {
  const files = ref<BookFileUploadItem[]>([])

  const pendingCount = computed(() => files.value.filter((f) => f.status === 'pending').length)
  const isUploading = computed(() => files.value.some((f) => f.status === 'uploading'))
  const doneCount = computed(() => files.value.filter((f) => f.status === 'done').length)
  const errorCount = computed(() => files.value.filter((f) => f.status === 'error').length)

  function addFiles(incoming: File[]) {
    for (const file of incoming) {
      if (files.value.some((f) => f.file.name === file.name && f.file.size === file.size)) continue

      const error = validateFile(file)
      files.value.push({
        id: `${file.name}-${file.size}-${file.lastModified}`,
        file,
        status: error ? 'error' : 'pending',
        progress: 0,
        error: error ?? undefined,
        validationError: error !== null,
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

  async function startUpload(bookId: number, options: { renameAfter?: boolean } = {}) {
    const pending = files.value.filter((f) => f.status === 'pending')
    if (pending.length === 0) return

    const renameAfter = options.renameAfter ?? false
    let index = 0
    async function runNext(): Promise<void> {
      const item = pending[index++]
      if (!item) return
      await uploadSingle(item, bookId)
      await runNext()
    }

    const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, pending.length) }, () => runNext())
    await Promise.all(workers)

    if (renameAfter && doneCount.value > 0) {
      await triggerRename(bookId)
    }
  }

  return {
    files,
    pendingCount,
    isUploading,
    doneCount,
    errorCount,
    addFiles,
    removeFile,
    retryFile,
    reset,
    startUpload,
  }
}
