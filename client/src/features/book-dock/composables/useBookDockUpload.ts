import { ref } from 'vue'
import { getValidToken } from '@/lib/api'
import type { BookDockFile } from '@bookorbit/types'

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
  bookDockFile?: BookDockFile
}

const CONCURRENCY = 3
// Kept comfortably under common reverse-proxy upload caps (e.g. Cloudflare's 100 MB limit)
// so large files are sent as sequential chunks instead of one oversized request.
const CHUNK_SIZE_BYTES = 40 * 1024 * 1024

function validateFile(file: File): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!SUPPORTED_FORMATS.includes(ext)) return `Unsupported type .${ext}`
  const { maxUploadSizeMb } = useAppInfo()
  const limitBytes = maxUploadSizeMb.value * 1024 * 1024
  if (file.size > limitBytes) return `File exceeds ${maxUploadSizeMb.value} MB limit`
  return null
}

async function sendPart(formData: FormData, onProgress: (loaded: number, total: number) => void): Promise<{ status: number; responseText: string }> {
  const token = await getValidToken()
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/v1/book-dock/upload')

    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total)
    }
    xhr.onload = () => resolve({ status: xhr.status, responseText: xhr.responseText })
    xhr.onerror = () => reject(new Error('Network error'))
    xhr.send(formData)
  })
}

function applyResult(item: UploadItem, status: number, responseText: string): void {
  if (status === 201) {
    item.status = 'done'
    item.progress = 100
    try {
      item.bookDockFile = JSON.parse(responseText) as BookDockFile
    } catch {
      // response parsing optional
    }
  } else {
    item.status = 'error'
    try {
      item.error = (JSON.parse(responseText) as { message?: string }).message ?? 'Upload failed'
    } catch {
      item.error = `Upload failed (${status})`
    }
  }
}

async function uploadWhole(item: UploadItem): Promise<void> {
  const formData = new FormData()
  formData.append('file', item.file)

  const { status, responseText } = await sendPart(formData, (loaded, total) => {
    item.progress = Math.round((loaded / total) * 100)
  })
  applyResult(item, status, responseText)
}

async function uploadChunked(item: UploadItem): Promise<void> {
  const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const totalChunks = Math.ceil(item.file.size / CHUNK_SIZE_BYTES)
  let uploadedBytes = 0

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const start = chunkIndex * CHUNK_SIZE_BYTES
    const end = Math.min(start + CHUNK_SIZE_BYTES, item.file.size)
    const chunk = item.file.slice(start, end)

    const formData = new FormData()
    formData.append('uploadId', uploadId)
    formData.append('chunkIndex', String(chunkIndex))
    formData.append('totalChunks', String(totalChunks))
    formData.append('fileName', item.file.name)
    formData.append('file', chunk, item.file.name)

    const chunkStartBytes = uploadedBytes
    const { status, responseText } = await sendPart(formData, (loaded) => {
      item.progress = Math.round(((chunkStartBytes + loaded) / item.file.size) * 100)
    })

    if (status !== 201 || chunkIndex === totalChunks - 1) {
      applyResult(item, status, responseText)
      return
    }

    uploadedBytes = end
  }
}

async function uploadSingle(item: UploadItem): Promise<void> {
  item.status = 'uploading'
  try {
    if (item.file.size > CHUNK_SIZE_BYTES) {
      await uploadChunked(item)
    } else {
      await uploadWhole(item)
    }
  } catch {
    item.status = 'error'
    item.error = 'Network error'
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
