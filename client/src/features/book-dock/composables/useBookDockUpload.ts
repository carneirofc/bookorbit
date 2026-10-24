import { computed, ref } from 'vue'
import { UPLOAD_SUPPORTED_FORMATS } from '@bookorbit/types'
import { uploadViaSession, UploadSessionError } from '@/features/upload/uploadSession'

import { useAppInfo } from '@/features/settings/composables/useAppInfo'
import { isRetryableUploadFailure, type BookDockUploadFailure } from '../lib/upload-failure'

export const SUPPORTED_FORMATS: readonly string[] = UPLOAD_SUPPORTED_FORMATS
export const SUPPORTED_FORMATS_ACCEPT = SUPPORTED_FORMATS.map((f) => `.${f}`).join(',')

export type FileUploadStatus = 'pending' | 'uploading' | 'done' | 'error'

export interface UploadItem {
  id: string
  file: File
  status: FileUploadStatus
  progress: number
  failure?: BookDockUploadFailure
}

const CONCURRENCY = 3

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

function validateFile(file: File): BookDockUploadFailure | null {
  const extension = fileExtension(file.name)
  if (!SUPPORTED_FORMATS.includes(extension)) return { kind: 'unsupported', extension }
  const { maxUploadSizeMb } = useAppInfo()
  const limitBytes = maxUploadSizeMb.value * 1024 * 1024
  if (file.size > limitBytes) return { kind: 'tooLarge', limitBytes }
  return null
}

/** fetch rejects with a TypeError and an expired login with a plain Error; neither carries a server reason. */
function uploadFailure(err: unknown): BookDockUploadFailure {
  if (!(err instanceof UploadSessionError) || err.status === 0) return { kind: 'network' }
  return {
    kind: 'server',
    status: err.status,
    errorCode: err.errorCode ?? null,
    message: err.serverMessage,
    fromBookOrbit: err.fromBookOrbit,
  }
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
    item.failure = uploadFailure(err)
  }
}

const files = ref<UploadItem[]>([])
const isUploading = ref(false)
const failures = computed(() => files.value.filter((f) => f.status === 'error'))

export function useBookDockUpload() {
  function addFiles(fileList: FileList | File[]) {
    for (const file of fileList) {
      const failure = validateFile(file)
      const item: UploadItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        status: failure ? 'error' : 'pending',
        progress: 0,
        failure: failure ?? undefined,
      }
      files.value.push(item)
    }
    processQueue()
  }

  function processQueue() {
    if (isUploading.value) return
    if (!files.value.some((f) => f.status === 'pending')) return
    isUploading.value = true
    void drainQueue()
  }

  async function drainQueue() {
    try {
      while (true) {
        const pending = files.value.filter((f) => f.status === 'pending').slice(0, CONCURRENCY)
        if (pending.length === 0) break
        await Promise.all(pending.map(uploadSingle))
      }
    } finally {
      // Nothing reads a finished upload, and holding its File keeps it alive for the session.
      files.value = files.value.filter((f) => f.status !== 'done')
      isUploading.value = false
    }
  }

  function retryFailure(id: string) {
    const item = files.value.find((f) => f.id === id)
    if (!item || item.status !== 'error' || !item.failure || !isRetryableUploadFailure(item.failure)) return
    item.status = 'pending'
    item.failure = undefined
    item.progress = 0
    processQueue()
  }

  function dismissFailure(id: string) {
    files.value = files.value.filter((f) => f.id !== id || f.status !== 'error')
  }

  function dismissAllFailures() {
    files.value = files.value.filter((f) => f.status !== 'error')
  }

  function clearAll() {
    files.value = []
  }

  return { files, failures, isUploading, addFiles, retryFailure, dismissFailure, dismissAllFailures, clearAll }
}
