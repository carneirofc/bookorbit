import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChunkUploadErrorCode, MIN_CHUNK_BYTES } from '@bookorbit/types'

vi.mock('@/lib/api', () => ({ getValidToken: vi.fn().mockResolvedValue('token') }))

import { uploadFileInChunks, UploadCanceledError, type ChunkUploadFailure } from '../useChunkedUploader'

interface Recorded {
  chunkIndex: number
  totalChunks: number
  chunkSize: number
  totalSize: number
  bodySize: number
  sha256?: string
  uploadIdHeader?: string
}

const CHUNK = MIN_CHUNK_BYTES
const requests: Recorded[] = []

/** Queue of responses, consumed one per request; the last entry repeats. */
let responses: { status: number; body: unknown }[] = []
let openRequests: { abort: () => void }[] = []

function progressEnvelope(receivedChunks: number, totalChunks: number) {
  return { status: 201, body: { chunked: true, complete: false, receivedChunks, totalChunks, finalizing: false } }
}

class FakeXhr {
  status = 0
  responseText = ''
  timeout = 0
  upload = { onprogress: null as ((e: { lengthComputable: boolean; loaded: number }) => void) | null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onabort: (() => void) | null = null
  private headers: Record<string, string> = {}
  private aborted = false

  open() {}

  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value
  }

  abort() {
    this.aborted = true
    this.onabort?.()
  }

  send(formData: FormData) {
    const blob = formData.get('file') as Blob
    requests.push({
      chunkIndex: Number(formData.get('chunkIndex')),
      totalChunks: Number(formData.get('totalChunks')),
      chunkSize: Number(formData.get('chunkSize')),
      totalSize: Number(formData.get('totalSize')),
      bodySize: blob.size,
      sha256: (formData.get('chunkSha256') as string | null) ?? undefined,
      uploadIdHeader: this.headers['x-upload-id'],
    })

    const handle = { abort: () => this.abort() }
    openRequests.push(handle)

    queueMicrotask(() => {
      if (this.aborted) return
      const next = responses.length > 1 ? responses.shift()! : responses[0]
      this.upload.onprogress?.({ lengthComputable: true, loaded: blob.size })
      this.status = next.status
      this.responseText = JSON.stringify(next.body)
      this.onload?.()
    })
  }
}

function fileOf(bytes: number, name = 'dune.epub'): File {
  return new File([new Uint8Array(bytes)], name)
}

async function upload<T>(file: File, signal = new AbortController().signal, onProgress = vi.fn()) {
  return uploadFileInChunks<T>({
    file,
    url: '/api/v1/book-dock/upload',
    uploadId: 'test-upload-1',
    chunkSizeBytes: CHUNK,
    signal,
    onProgress,
  })
}

describe('uploadFileInChunks', () => {
  beforeEach(() => {
    requests.length = 0
    openRequests = []
    responses = [{ status: 201, body: { id: 7, fileName: 'dune.epub' } }]
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    // Not a secure context in most self-hosted setups, so no subtle crypto.
    vi.stubGlobal('crypto', {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  describe('chunk splitting', () => {
    it('sends a single chunk for a small file', async () => {
      await upload(fileOf(1000))

      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ chunkIndex: 0, totalChunks: 1, bodySize: 1000, totalSize: 1000 })
    })

    it('splits a large file and makes the last chunk the remainder', async () => {
      responses = [progressEnvelope(1, 3), progressEnvelope(2, 3), { status: 201, body: { id: 7 } }]

      await upload(fileOf(CHUNK * 2 + 123))

      expect(requests).toHaveLength(3)
      expect(requests.map((r) => r.bodySize).sort((a, b) => b - a)).toEqual([CHUNK, CHUNK, 123])
      expect(new Set(requests.map((r) => r.chunkIndex))).toEqual(new Set([0, 1, 2]))
    })

    it('sends an empty file as one chunk rather than none', async () => {
      await upload(fileOf(0))

      expect(requests).toHaveLength(1)
    })

    it('marks every request with the upload id header so the server can size the limit', async () => {
      await upload(fileOf(1000))

      expect(requests[0].uploadIdHeader).toBe('test-upload-1')
    })

    it('omits the checksum when the browser has no subtle crypto', async () => {
      await upload(fileOf(1000))

      expect(requests[0].sha256).toBeUndefined()
    })
  })

  describe('completion', () => {
    it('resolves with the body of whichever request finished the upload', async () => {
      responses = [progressEnvelope(1, 2), { status: 201, body: { id: 42, fileName: 'dune.epub' } }]

      await expect(upload(fileOf(CHUNK + 10))).resolves.toEqual({ id: 42, fileName: 'dune.epub' })
    })

    it('fails when the server only ever returns progress envelopes', async () => {
      responses = [progressEnvelope(1, 1)]

      await expect(upload(fileOf(1000))).rejects.toMatchObject({ message: expect.stringContaining('never confirmed') })
    })

    it('reports progress that reaches the full file size', async () => {
      const onProgress = vi.fn()
      responses = [progressEnvelope(1, 2), { status: 201, body: { id: 1 } }]

      await upload(fileOf(CHUNK + 10), undefined, onProgress)

      const last = onProgress.mock.calls.at(-1)![0]
      expect(last).toEqual({ loadedBytes: CHUNK + 10, totalBytes: CHUNK + 10 })
    })
  })

  describe('retry', () => {
    it('re-sends a chunk the server reported as corrupt', async () => {
      vi.useFakeTimers()
      responses = [
        { status: 422, body: { message: 'bad chunk', errorCode: ChunkUploadErrorCode.CHUNK_CORRUPT } },
        { status: 201, body: { id: 9 } },
      ]

      const promise = upload(fileOf(1000))
      await vi.advanceTimersByTimeAsync(5000)

      await expect(promise).resolves.toEqual({ id: 9 })
      expect(requests).toHaveLength(2)
      expect(requests[0].chunkIndex).toBe(0)
      expect(requests[1].chunkIndex).toBe(0)
    })

    it('re-sends after a server error', async () => {
      vi.useFakeTimers()
      responses = [
        { status: 503, body: {} },
        { status: 201, body: { id: 9 } },
      ]

      const promise = upload(fileOf(1000))
      await vi.advanceTimersByTimeAsync(5000)

      await expect(promise).resolves.toEqual({ id: 9 })
      expect(requests).toHaveLength(2)
    })

    it('gives up after the attempt limit', async () => {
      vi.useFakeTimers()
      responses = [{ status: 422, body: { message: 'bad chunk', errorCode: ChunkUploadErrorCode.CHUNK_CORRUPT } }]

      const promise = upload(fileOf(1000)).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(30_000)

      expect((await promise) as ChunkUploadFailure).toMatchObject({ errorCode: ChunkUploadErrorCode.CHUNK_CORRUPT })
      expect(requests).toHaveLength(3)
    })

    it.each([
      ['an expired session', 410, ChunkUploadErrorCode.SESSION_EXPIRED],
      ['a mismatched session', 409, ChunkUploadErrorCode.SESSION_MISMATCH],
      ['a file that is too large', 413, ChunkUploadErrorCode.UPLOAD_TOO_LARGE],
      ['content that contradicts the extension', 422, ChunkUploadErrorCode.CONTENT_TYPE_MISMATCH],
    ])('does not retry %s', async (_label, status, errorCode) => {
      responses = [{ status, body: { message: 'nope', errorCode } }]

      await expect(upload(fileOf(1000))).rejects.toMatchObject({ errorCode })
      expect(requests).toHaveLength(1)
    })
  })

  describe('cancellation', () => {
    it('rejects with a cancellation once aborted', async () => {
      const controller = new AbortController()
      responses = [progressEnvelope(1, 3)]

      const promise = upload(fileOf(CHUNK * 2 + 10), controller.signal).catch((e: unknown) => e)
      controller.abort()
      openRequests.forEach((r) => r.abort())

      expect(await promise).toBeInstanceOf(UploadCanceledError)
    })

    it('refuses to start when the signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()

      await expect(upload(fileOf(1000), controller.signal)).rejects.toBeInstanceOf(UploadCanceledError)
      expect(requests).toHaveLength(0)
    })
  })
})
