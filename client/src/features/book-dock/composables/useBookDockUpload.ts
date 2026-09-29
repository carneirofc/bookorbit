import { ref } from 'vue'
import { uploadViaSession } from '@/features/upload/uploadSession'

import { useAppInfo } from '@/features/settings/composables/useAppInfo'

export const SUPPORTED_FORMATS = ['epub', 'kepub', 'pdf', 'mobi', 'azw3', 'cbz', 'cbr', 'cb7', 'fb2', 'm4b', 'm4a', 'mp3', 'opus', 'ogg', 'flac']
export const SUPPORTED_FORMATS_ACCEPT = SUPPORTED_FORMATS.map((f) => `.${f}`).join(',')

export type FileUploadStatus = 'pending' | 'uploading' | 'done' | 'error'

export interface UploadItem {
  id: string
  file: File
  status: FileUploadStatus
  progress: number
  error?: string
}

const CONCURRENCY = 3

function validateFile(file: File): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!SUPPORTED_FORMATS.includes(ext)) return `Unsupported type .${ext}`
  const { maxUploadSizeMb } = useAppInfo()
  const limitBytes = maxUploadSizeMb.value * 1024 * 1024
  if (file.size > limitBytes) return `File exceeds ${maxUploadSizeMb.value} MB limit`
  return null
}

async function uploadSingle(item: UploadItem): Promise<void> {
  item.status = 'uploading'
  item.progress = 0
  try {
    await uploadViaSession({
      file: item.file,
      target: { kind: 'book_dock' },
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

const files = ref<UploadItem[]>([])
const isUploading = ref(false)

export function useBookDockUpload() {
  function addFiles(fileList: FileList | File[]) {
    for (const file of fileList) {
      const error = validateFile(file)
      const item: UploadItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        status: error ? 'error' : 'pending',
        progress: 0,
        error: error ?? undefined,
      }
      files.value.push(item)
    }
    processQueue()
  }

  function processQueue() {
    if (isUploading.value) return
    isUploading.value = true
    void drainQueue()
  }

  async function drainQueue() {
    while (true) {
      const pending = files.value.filter((f) => f.status === 'pending').slice(0, CONCURRENCY)
      if (pending.length === 0) break
      await Promise.all(pending.map(uploadSingle))
    }
    isUploading.value = false
  }

  function clearCompleted() {
    files.value = files.value.filter((f) => f.status !== 'done')
  }

  function clearAll() {
    files.value = []
  }

  return { files, isUploading, addFiles, clearCompleted, clearAll }
}
