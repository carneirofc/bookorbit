import { CHUNK_UPLOAD_HEADER, ChunkUploadErrorCode, DEFAULT_UPLOAD_CHUNK_BYTES, MAX_CHUNK_BYTES, MIN_CHUNK_BYTES } from '@bookorbit/types'

import { getValidToken } from '@/lib/api'

/** Concurrent chunk requests across every file. Browsers cap ~6 per host on HTTP/1.1. */
const MAX_IN_FLIGHT_CHUNKS = 4
const MAX_CHUNK_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 500
/** A request that transfers nothing for this long is treated as dead and retried. */
const STALL_TIMEOUT_MS = 60_000

export class UploadCanceledError extends Error {
  constructor() {
    super('Upload canceled')
    this.name = 'UploadCanceledError'
  }
}

export interface ChunkUploadFailure {
  message: string
  errorCode?: string
  status: number
}

export interface UploadProgress {
  loadedBytes: number
  totalBytes: number
}

export interface ChunkedUploadOptions {
  file: File
  url: string
  /** Supplied by the caller so it can cancel the server-side session by id. */
  uploadId: string
  chunkSizeBytes?: number
  signal: AbortSignal
  onProgress: (progress: UploadProgress) => void
  /** Called once every byte is sent and the server is still assembling. */
  onFinalizing?: () => void
}

/** Codes that mean "this one chunk went bad", as opposed to "this session is unusable". */
function isChunkRetryable(status: number, errorCode?: string): boolean {
  if (errorCode === ChunkUploadErrorCode.CHUNK_CORRUPT) return true
  if (errorCode) return false
  return status === 0 || status >= 500
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new UploadCanceledError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function parseFailure(status: number, responseText: string): ChunkUploadFailure {
  try {
    const body = JSON.parse(responseText) as { message?: string | string[]; errorCode?: string }
    const message = Array.isArray(body.message) ? body.message.join(', ') : body.message
    return { message: message ?? `Upload failed (${status})`, errorCode: body.errorCode, status }
  } catch {
    return { message: status === 0 ? 'Network error' : `Upload failed (${status})`, status }
  }
}

interface SendResult {
  status: number
  responseText: string
}

/**
 * One multipart request. XHR rather than fetch because only XHR reports upload progress.
 */
function send(
  url: string,
  formData: FormData,
  token: string | null,
  headers: Record<string, string>,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
): Promise<SendResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.timeout = STALL_TIMEOUT_MS

    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)

    function cleanup() {
      signal.removeEventListener('abort', onAbort)
    }
    function onAbort() {
      xhr.abort()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded)
    }
    xhr.onload = () => {
      cleanup()
      resolve({ status: xhr.status, responseText: xhr.responseText })
    }
    xhr.onerror = () => {
      cleanup()
      resolve({ status: 0, responseText: '' })
    }
    xhr.ontimeout = () => {
      cleanup()
      resolve({ status: 0, responseText: '' })
    }
    xhr.onabort = () => {
      cleanup()
      reject(new UploadCanceledError())
    }

    xhr.send(formData)
  })
}

/**
 * SHA-256 of a chunk, or null where the browser will not provide one.
 *
 * `crypto.subtle` only exists in a secure context, and a self-hosted BookOrbit is often
 * reached over plain HTTP on a LAN. The server treats the checksum as optional for
 * exactly this reason, so a non-secure context loses per-chunk verification but still
 * uploads, and the server still hashes the assembled file.
 */
async function hashChunk(blob: Blob): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

function resolveChunkSize(requested?: number): number {
  const size = requested && requested > 0 ? requested : DEFAULT_UPLOAD_CHUNK_BYTES
  return Math.min(Math.max(size, MIN_CHUNK_BYTES), MAX_CHUNK_BYTES)
}

/** Runs `tasks` with at most `limit` in flight, failing fast on the first rejection. */
async function pooled(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0

  async function worker(): Promise<void> {
    while (true) {
      const task = tasks[next++]
      if (!task) return
      await task()
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()))
}

export function newUploadId(): string {
  // randomUUID is secure-context only, and a self-hosted install is often plain HTTP.
  const random =
    typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`

  return random.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64)
}

/**
 * Uploads one file, splitting it into chunks that fly concurrently.
 *
 * Resolves with the parsed body of whichever request completed the upload; rejects with
 * a `ChunkUploadFailure` on an unrecoverable error, or `UploadCanceledError` on abort.
 */
export async function uploadFileInChunks<TResult>(options: ChunkedUploadOptions): Promise<TResult> {
  const { file, url, uploadId, signal, onProgress, onFinalizing } = options
  const chunkSize = resolveChunkSize(options.chunkSizeBytes)
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize))

  // A failing chunk aborts its siblings rather than leaving them to finish an upload
  // that can no longer complete.
  const controller = new AbortController()
  const abortAll = () => controller.abort()
  signal.addEventListener('abort', abortAll, { once: true })
  if (signal.aborted) controller.abort()

  // Progress is the sum of every chunk's own counter, so a chunk that fails and retries
  // rewinds only its own contribution rather than the whole file's.
  const loadedPerChunk = new Array<number>(totalChunks).fill(0)
  let announcedFinalizing = false
  const report = () => {
    const loadedBytes = loadedPerChunk.reduce((a, b) => a + b, 0)
    onProgress({ loadedBytes, totalBytes: file.size })
    // Every byte is on the wire but the server has not answered yet: it is hashing,
    // checking the signature, moving the file and inserting the row.
    if (loadedBytes >= file.size && !announcedFinalizing) {
      announcedFinalizing = true
      onFinalizing?.()
    }
  }

  let completion: TResult | null = null

  async function sendChunk(chunkIndex: number): Promise<void> {
    const start = chunkIndex * chunkSize
    const blob = file.slice(start, Math.min(start + chunkSize, file.size))
    const checksum = await hashChunk(blob)

    for (let attempt = 1; ; attempt++) {
      if (controller.signal.aborted) throw new UploadCanceledError()
      loadedPerChunk[chunkIndex] = 0
      report()

      const formData = new FormData()
      formData.append('uploadId', uploadId)
      formData.append('chunkIndex', String(chunkIndex))
      formData.append('totalChunks', String(totalChunks))
      formData.append('chunkSize', String(chunkSize))
      formData.append('totalSize', String(file.size))
      formData.append('fileName', file.name)
      if (checksum) formData.append('chunkSha256', checksum)
      formData.append('file', blob, file.name)

      const token = await getValidToken()
      const { status, responseText } = await send(url, formData, token, { [CHUNK_UPLOAD_HEADER]: uploadId }, controller.signal, (loaded) => {
        loadedPerChunk[chunkIndex] = Math.min(loaded, blob.size)
        report()
      })

      if (status >= 200 && status < 300) {
        loadedPerChunk[chunkIndex] = blob.size
        report()

        const body = responseText ? (JSON.parse(responseText) as Record<string, unknown>) : null
        if (body && body.chunked === true && body.complete === false) {
          if (body.finalizing === true) onFinalizing?.()
          return
        }
        // Anything that is not a progress envelope is the finished resource.
        completion = body as TResult
        return
      }

      const failure = parseFailure(status, responseText)
      if (attempt >= MAX_CHUNK_ATTEMPTS || !isChunkRetryable(status, failure.errorCode)) throw failure

      await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * RETRY_BASE_DELAY_MS, controller.signal)
    }
  }

  try {
    await pooled(
      Array.from({ length: totalChunks }, (_, i) => () => sendChunk(i)),
      MAX_IN_FLIGHT_CHUNKS,
    )
  } catch (err) {
    controller.abort()
    throw err
  } finally {
    signal.removeEventListener('abort', abortAll)
  }

  if (completion === null) {
    throw { message: 'The server never confirmed the upload', status: 0 } satisfies ChunkUploadFailure
  }

  return completion
}

/**
 * Best-effort release of the server's partial file. The server sweeps abandoned sessions
 * anyway, so a failure here costs disk for a while and nothing else.
 */
export async function cancelChunkedUpload(baseUrl: string, uploadId: string): Promise<void> {
  const token = await getValidToken()
  await fetch(`${baseUrl}/${uploadId}`, {
    method: 'DELETE',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).catch(() => undefined)
}
