import type { BookDockFile } from '@bookorbit/types'

import { useAppInfo } from '@/features/settings/composables/useAppInfo'
import { useUploadQueue } from '@/features/upload/composables/useUploadQueue'

export const SUPPORTED_FORMATS = ['epub', 'kepub', 'pdf', 'mobi', 'azw3', 'cbz', 'cbr', 'cb7', 'fb2', 'm4b', 'm4a', 'mp3', 'opus', 'ogg', 'flac']
export const SUPPORTED_FORMATS_ACCEPT = SUPPORTED_FORMATS.map((f) => `.${f}`).join(',')

const UPLOAD_URL = '/api/v1/book-dock/upload'

function validateFile(file: File): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!SUPPORTED_FORMATS.includes(ext)) return `Unsupported type .${ext}`

  const { maxUploadSizeMb } = useAppInfo()
  const limitBytes = maxUploadSizeMb.value * 1024 * 1024
  if (file.size > limitBytes) return `File exceeds ${maxUploadSizeMb.value} MB limit`

  return null
}

/**
 * Book Dock's view of the shared upload queue. Transport, chunking, retry, cancellation
 * and progress all live in `useUploadQueue`; this only supplies the endpoint, the format
 * rules, and the callback that refreshes the dock list.
 */
export function useBookDockUpload(onFileIngested?: () => void) {
  const { uploadChunkSizeBytes } = useAppInfo()

  return useUploadQueue<BookDockFile>({
    url: UPLOAD_URL,
    cancelUrl: UPLOAD_URL,
    chunkSizeBytes: () => uploadChunkSizeBytes.value,
    validate: validateFile,
    // Refresh per completed file rather than once the whole batch drains, so a long
    // queue does not leave finished books invisible until the end.
    onFileDone: () => onFileIngested?.(),
  })
}
