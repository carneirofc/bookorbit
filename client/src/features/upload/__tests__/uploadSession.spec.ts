import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>())
vi.mock('@/lib/api', () => ({
  api,
  getValidToken: vi.fn<() => Promise<string>>().mockResolvedValue('test-token'),
}))

import { uploadViaSession, UploadSessionError } from '../uploadSession'

const CHUNK = 4

interface ChunkCall {
  url: string
  offset: number
  size: number
}

type ChunkResponder = (call: ChunkCall) => { status: number; body?: unknown }

let chunkCalls: ChunkCall[]
let respondToChunk: ChunkResponder

class MockXMLHttpRequest {
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  timeout = 0
  status = 0
  responseText = ''
  private url = ''
  private headers: Record<string, string> = {}

  open(_method: string, url: string) {
    this.url = url
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }

  send(form: FormData) {
    const blob = form.get('file') as Blob
    const call = { url: this.url, offset: Number(this.headers['Upload-Offset']), size: blob.size }
    chunkCalls.push(call)
    const { status, body } = respondToChunk(call)
    this.status = status
    this.responseText = body === undefined ? '' : JSON.stringify(body)
    queueMicrotask(() => (status === 0 ? this.onerror?.() : this.onload?.()))
  }
}

function session(overrides: Record<string, unknown> = {}) {
  return { id: 's1', status: 'receiving', receivedBytes: 0, sizeBytes: 10, chunkSizeBytes: CHUNK, ...overrides }
}

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) }
}

/** Serves session JSON calls: create, complete and the polling GETs, in that order of URL shape. */
function serveApi({ create = session(), complete = session({ status: 'processing' }), polls = [session({ status: 'completed', bookId: 9 })] } = {}) {
  const pollQueue = [...polls]
  api.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/v1/uploads' && init?.method === 'POST') return Promise.resolve(json(201, create))
    if (url.endsWith('/complete')) return Promise.resolve(json(202, complete))
    const next = pollQueue.length > 1 ? pollQueue.shift() : pollQueue[0]
    return Promise.resolve(json(200, next))
  })
}

function acceptEveryChunk(): ChunkResponder {
  return ({ offset, size }) => ({ status: 200, body: session({ receivedBytes: offset + size }) })
}

const file = new File(['0123456789'], 'book.epub', { type: 'application/epub+zip' })

describe('uploadViaSession', () => {
  beforeEach(() => {
    chunkCalls = []
    respondToChunk = acceptEveryChunk()
    api.mockReset()
    vi.stubGlobal('XMLHttpRequest', MockXMLHttpRequest)
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn()
      return 0
    }) as unknown as typeof setTimeout)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('sends the file in server-sized chunks at increasing offsets, then follows the import to completion', async () => {
    serveApi()
    const progress: number[] = []

    const result = await uploadViaSession({ file, target: { kind: 'book_dock' }, onProgress: (p) => progress.push(p) })

    expect(chunkCalls.map(({ offset, size }) => [offset, size])).toEqual([
      [0, 4],
      [4, 4],
      [8, 2],
    ])
    expect(chunkCalls[0]!.url).toBe('/api/v1/uploads/s1/chunks')
    expect(result.bookId).toBe(9)
    expect(progress.at(-1)).toBe(100)
    expect(progress.slice(0, -1).every((p) => p < 100)).toBe(true)

    const createBody = JSON.parse(api.mock.calls[0]![1]!.body as string)
    expect(createBody).toMatchObject({ filename: 'book.epub', sizeBytes: 10, target: { kind: 'book_dock' }, contentType: 'application/epub+zip' })
    expect(typeof createBody.idempotencyKey).toBe('string')
  })

  it('jumps to the offset the server reports when a retried chunk had already landed', async () => {
    serveApi()
    let rejected = false
    respondToChunk = (call) => {
      if (call.offset === 4 && !rejected) {
        rejected = true
        return { status: 409, body: { errorCode: 'UPLOAD_OFFSET_MISMATCH', expectedOffset: 8 } }
      }
      return acceptEveryChunk()(call)
    }

    await uploadViaSession({ file, target: { kind: 'book_dock' } })

    expect(chunkCalls.map((c) => c.offset)).toEqual([0, 4, 8])
  })

  it('retries a chunk after a proxy error, resuming from the byte count the server holds', async () => {
    serveApi({ polls: [session({ receivedBytes: 4 }), session({ status: 'completed' })] })
    let failed = false
    respondToChunk = (call) => {
      if (call.offset === 4 && !failed) {
        failed = true
        return { status: 524 }
      }
      return acceptEveryChunk()(call)
    }

    await uploadViaSession({ file, target: { kind: 'library', libraryId: 1 } })

    expect(chunkCalls.map((c) => c.offset)).toEqual([0, 4, 4, 8])
  })

  it('fails without retrying when the server rejects a chunk outright', async () => {
    serveApi()
    respondToChunk = () => ({ status: 400, body: { message: 'Unsupported file', errorCode: 'UPLOAD_CONTENT_INVALID' } })

    await expect(uploadViaSession({ file, target: { kind: 'book_dock' } })).rejects.toMatchObject({
      message: 'Unsupported file',
      errorCode: 'UPLOAD_CONTENT_INVALID',
    })
    expect(chunkCalls).toHaveLength(1)
  })

  it('surfaces the reason an import failed after every byte arrived', async () => {
    serveApi({ polls: [session({ status: 'failed', errorCode: 'UPLOAD_CHECKSUM_MISMATCH', errorMessage: 'File checksum does not match' })] })

    const upload = uploadViaSession({ file, target: { kind: 'book_dock' } })

    await expect(upload).rejects.toBeInstanceOf(UploadSessionError)
    await expect(upload).rejects.toMatchObject({ message: 'File checksum does not match', errorCode: 'UPLOAD_CHECKSUM_MISMATCH' })
  })

  it('does not keep retrying once the login has expired', async () => {
    serveApi()
    api.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/v1/uploads' && init?.method === 'POST') return Promise.resolve(json(201, session()))
      return Promise.reject(new Error('Session expired'))
    })

    await expect(uploadViaSession({ file, target: { kind: 'book_dock' } })).rejects.toThrow('Session expired')
    expect(api.mock.calls.filter(([url]) => String(url).endsWith('/complete'))).toHaveLength(1)
  })
})
