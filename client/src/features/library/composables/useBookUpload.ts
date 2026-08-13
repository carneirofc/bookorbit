import { computed, ref } from 'vue'
import type { UploadResult } from '@bookorbit/types'

import { useAppInfo } from '@/features/settings/composables/useAppInfo'
import { useUploadQueue } from '@/features/upload/composables/useUploadQueue'

export const SUPPORTED_FORMATS = ['epub', 'kepub', 'pdf', 'mobi', 'azw3', 'cbz', 'cbr', 'cb7', 'fb2', 'm4b', 'm4a', 'mp3', 'opus', 'ogg', 'flac']
export const SUPPORTED_FORMATS_ACCEPT = SUPPORTED_FORMATS.map((f) => `.${f}`).join(',')
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024 // 500 MB

export type { UploadItem as FileUploadItem, UploadItemStatus as FileUploadStatus } from '@/features/upload/composables/useUploadQueue'

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

/**
 * Library uploads over the shared chunked transport.
 *
 * The destination library is chosen after the files are picked, so files are added held
 * and only released once `startUpload` knows the endpoint.
 */
export function useBookUpload() {
  const { uploadChunkSizeBytes } = useAppInfo()
  const ownedIds = ref<string[]>([])

  const queue = useUploadQueue<UploadResult>({
    // Placeholder until startUpload binds the chosen library; files are held until then.
    url: '',
    cancelUrl: '',
    chunkSizeBytes: () => uploadChunkSizeBytes.value,
    validate: validateFile,
  })

  const files = computed(() => queue.files.value.filter((f) => ownedIds.value.includes(f.id)))
  const pendingCount = computed(() => files.value.filter((f) => f.status === 'pending').length)
  const isUploading = computed(() => files.value.some((f) => f.status === 'uploading' || f.status === 'finalizing'))
  const doneCount = computed(() => files.value.filter((f) => f.status === 'done').length)
  const errorCount = computed(() => files.value.filter((f) => f.status === 'error').length)
  const uploadedBookIds = computed(() => files.value.filter((f) => f.result?.bookId !== undefined).map((f) => f.result!.bookId))

  function addFiles(incoming: File[]) {
    const fresh = incoming.filter((file) => !files.value.some((f) => f.file.name === file.name && f.file.size === file.size))
    ownedIds.value.push(...queue.addFiles(fresh, { hold: true }))
  }

  function removeFile(id: string) {
    queue.remove(id)
    ownedIds.value = ownedIds.value.filter((owned) => owned !== id)
  }

  function reset() {
    for (const id of [...ownedIds.value]) queue.remove(id)
    ownedIds.value = []
  }

  async function startUpload(libraryId: number, folderId?: number) {
    const base = `/api/v1/libraries/${libraryId}/upload`
    const pending = files.value.filter((f) => f.status === 'pending').map((f) => f.id)
    if (pending.length === 0) return

    await queue.release(pending, {
      url: folderId !== undefined ? `${base}?folderId=${folderId}` : base,
      cancelUrl: base,
    })
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
    retryFile: queue.retry,
    reset,
    startUpload,
  }
}
