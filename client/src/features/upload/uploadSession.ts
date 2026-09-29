import type { UploadSessionResponse, UploadTarget } from '@bookorbit/types'

import { api, getValidToken } from '@/lib/api'

const SESSIONS_URL = '/api/v1/uploads'
const MAX_CHUNK_ATTEMPTS = 5
const RETRY_BASE_DELAY_MS = 1_000
/** A chunk request that moves no bytes for this long is treated as dead and retried. */
const CHUNK_STALL_TIMEOUT_MS = 120_000
const POLL_INITIAL_DELAY_MS = 1_000
const POLL_MAX_DELAY_MS = 5_000
const MAX_CONSECUTIVE_POLL_FAILURES = 30

export class UploadSessionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
  ) {
    super(message)
    this.name = 'UploadSessionError'
  }
}

export interface SessionUploadOptions {
  file: File
  target: UploadTarget
  /** 0-100. Reaches 100 only once the server has imported the file. */
  onProgress?: (percent: number) => void
}

interface ErrorBody {
  message?: string | string[]
  errorCode?: string
  expectedOffset?: number
}

function parseErrorBody(text: string): ErrorBody {
  try {
    return JSON.parse(text) as ErrorBody
  } catch {
    return {}
  }
}

function toError(status: number, body: ErrorBody): UploadSessionError {
  const message = Array.isArray(body.message) ? body.message.join(', ') : body.message
  return new UploadSessionError(message ?? (status === 0 ? 'Network error' : `Upload failed (${status})`), status, body.errorCode)
}

function isTransient(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500
}

/** fetch rejects with a TypeError on a network failure; anything else (an expired login) is final. */
function isRetryableError(err: unknown): boolean {
  if (err instanceof UploadSessionError) return isTransient(err.status)
  return err instanceof TypeError
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function newIdempotencyKey(): string {
  // randomUUID is secure-context only, and a self-hosted install is often reached over plain HTTP.
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

async function requestJson(input: string, init?: RequestInit): Promise<UploadSessionResponse> {
  const res = await api(input, init)
  const text = await res.text()
  if (!res.ok) throw toError(res.status, parseErrorBody(text))
  return JSON.parse(text) as UploadSessionResponse
}

interface ChunkResult {
  status: number
  body: string
}

/** XHR rather than fetch because only XHR reports upload progress. */
async function sendChunk(sessionId: string, offset: number, blob: Blob, filename: string, onLoaded: (loaded: number) => void): Promise<ChunkResult> {
  const token = await getValidToken()
  return new Promise((resolve) => {
    const formData = new FormData()
    formData.append('file', blob, filename)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${SESSIONS_URL}/${sessionId}/chunks`)
    xhr.timeout = CHUNK_STALL_TIMEOUT_MS
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('Upload-Offset', String(offset))

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onLoaded(Math.min(e.loaded, blob.size))
    }
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText })
    xhr.onerror = () => resolve({ status: 0, body: '' })
    xhr.ontimeout = () => resolve({ status: 0, body: '' })
    xhr.send(formData)
  })
}

/** `complete` is idempotent on the server, so a dropped response is safe to retry. */
async function completeSession(sessionId: string): Promise<UploadSessionResponse> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestJson(`${SESSIONS_URL}/${sessionId}/complete`, { method: 'POST' })
    } catch (err) {
      if (!isRetryableError(err) || attempt >= MAX_CHUNK_ATTEMPTS) throw err
      await wait(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
    }
  }
}

async function waitForImport(sessionId: string): Promise<UploadSessionResponse> {
  let delay = POLL_INITIAL_DELAY_MS
  let failures = 0
  while (true) {
    await wait(delay)
    let session: UploadSessionResponse
    try {
      session = await requestJson(`${SESSIONS_URL}/${sessionId}`)
      failures = 0
    } catch (err) {
      if (!isRetryableError(err) || ++failures >= MAX_CONSECUTIVE_POLL_FAILURES) throw err
      delay = Math.min(delay * 2, POLL_MAX_DELAY_MS)
      continue
    }
    if (session.status === 'completed') return session
    if (session.status !== 'processing') {
      throw new UploadSessionError(session.errorMessage ?? `Upload ${session.status}`, 200, session.errorCode ?? undefined)
    }
    delay = Math.min(delay * 1.5, POLL_MAX_DELAY_MS)
  }
}

/**
 * Uploads a file through the resumable upload-session API.
 *
 * Each request carries one chunk of at most the server's chunk size (16 MB), so no single request
 * crosses the body cap of a reverse proxy such as a Cloudflare Tunnel (100 MB). A failed chunk is
 * resumed from the server's own byte count rather than restarted, and the import after the last
 * chunk is followed by polling, since it can outlast a proxy's response timeout.
 */
export async function uploadViaSession({ file, target, onProgress }: SessionUploadOptions): Promise<UploadSessionResponse> {
  let session = await requestJson(SESSIONS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      sizeBytes: file.size,
      idempotencyKey: newIdempotencyKey(),
      target,
      ...(file.type ? { contentType: file.type } : {}),
    }),
  })

  const report = (loaded: number) => {
    if (!onProgress) return
    // Held below 100 until the import finishes, so "uploaded" never reads as "done".
    onProgress(file.size === 0 ? 99 : Math.min(99, Math.round((loaded / file.size) * 100)))
  }

  let offset = session.receivedBytes
  let failures = 0
  while (offset < file.size) {
    const blob = file.slice(offset, Math.min(offset + session.chunkSizeBytes, file.size))
    const chunkStart = offset
    const { status, body } = await sendChunk(session.id, offset, blob, file.name, (loaded) => report(chunkStart + loaded))

    if (status >= 200 && status < 300) {
      offset = (JSON.parse(body) as UploadSessionResponse).receivedBytes
      failures = 0
      report(offset)
      continue
    }

    const error = parseErrorBody(body)
    // The server already holds more (or less) than we assumed: a retried chunk that did land.
    if (status === 409 && typeof error.expectedOffset === 'number') {
      offset = error.expectedOffset
      continue
    }
    if (!isTransient(status) || ++failures >= MAX_CHUNK_ATTEMPTS) throw toError(status, error)

    await wait(RETRY_BASE_DELAY_MS * 2 ** (failures - 1))
    try {
      session = await requestJson(`${SESSIONS_URL}/${session.id}`)
      offset = session.receivedBytes
    } catch (err) {
      if (!isRetryableError(err)) throw err
      // Keep the local offset; the next chunk attempt gets the authoritative one via a 409.
    }
  }

  session = await completeSession(session.id)
  if (session.status === 'processing') session = await waitForImport(session.id)
  if (session.status !== 'completed') {
    throw new UploadSessionError(session.errorMessage ?? `Upload ${session.status}`, 200, session.errorCode ?? undefined)
  }

  onProgress?.(100)
  return session
}
