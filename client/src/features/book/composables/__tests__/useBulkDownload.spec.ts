import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookExportSessionResponse } from '@bookorbit/types'

const mocks = vi.hoisted(() => ({
  api: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
  download: vi.fn<(url: string) => void>(),
}))

vi.mock('@/lib/api', () => ({ api: mocks.api }))
vi.mock('@/lib/browserDownload', () => ({ triggerBrowserDownload: mocks.download }))

function makeSession(overrides: Partial<BookExportSessionResponse> = {}): BookExportSessionResponse {
  return {
    token: 'tok-1',
    scope: 'primary',
    expiresAt: '2026-04-24T20:00:00.000Z',
    bookCount: 3,
    skippedBookCount: 0,
    totalBytes: 300,
    parts: [
      { index: 0, bookCount: 2, fileCount: 2, bytes: 200, oversized: false },
      { index: 1, bookCount: 1, fileCount: 1, bytes: 100, oversized: false },
    ],
    maxConcurrentExports: 2,
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('useBulkDownload', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'))
    mocks.api.mockReset()
    mocks.download.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('downloads a single-part selection immediately without opening the dialog', async () => {
    mocks.api.mockResolvedValue(jsonResponse(makeSession({ parts: [makeSession().parts[0]] })))
    const { useBulkDownload } = await import('../useBulkDownload')
    const { startBulkDownload, open } = useBulkDownload()

    await startBulkDownload({ bookIds: [1, 2] }, 'all')

    const [url, init] = mocks.api.mock.calls[0]
    expect(url).toBe('/api/v1/books/export/sessions')
    expect(JSON.parse(String(init?.body))).toEqual({ bookIds: [1, 2], scope: 'all', partSizeMb: 1024 })
    expect(mocks.download).toHaveBeenCalledWith('/api/v1/books/export/sessions/tok-1/parts/0')
    expect(open.value).toBe(false)
  })

  it('opens the dialog for multi-part downloads and walks through the parts', async () => {
    mocks.api.mockResolvedValue(jsonResponse(makeSession()))
    const { useBulkDownload } = await import('../useBulkDownload')
    const { startBulkDownload, open, nextPartIndex, downloadNextPart } = useBulkDownload()

    await startBulkDownload({ query: { libraryId: 4 } })

    expect(open.value).toBe(true)
    expect(mocks.download).not.toHaveBeenCalled()
    await downloadNextPart()
    expect(nextPartIndex.value).toBe(1)
    await downloadNextPart()
    expect(nextPartIndex.value).toBeNull()
    expect(mocks.download.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/books/export/sessions/tok-1/parts/0',
      '/api/v1/books/export/sessions/tok-1/parts/1',
    ])
  })

  it('re-prepares an expired session before handing out a part URL', async () => {
    mocks.api.mockResolvedValueOnce(jsonResponse(makeSession())).mockResolvedValueOnce(jsonResponse(makeSession({ token: 'tok-2' })))
    const { useBulkDownload } = await import('../useBulkDownload')
    const { startBulkDownload, downloadPart } = useBulkDownload()

    await startBulkDownload({ query: { libraryId: 4 } })
    vi.setSystemTime(new Date('2026-04-25T00:00:00.000Z'))
    await downloadPart(1)

    expect(mocks.api).toHaveBeenCalledTimes(2)
    expect(mocks.download).toHaveBeenCalledWith('/api/v1/books/export/sessions/tok-2/parts/1')
  })

  it('keeps the dialog open with the server error when preparing fails', async () => {
    mocks.api.mockResolvedValue(jsonResponse({ message: 'None of the selected books have downloadable files' }, 400))
    const { useBulkDownload } = await import('../useBulkDownload')
    const { startBulkDownload, open, error, session } = useBulkDownload()

    await startBulkDownload({ bookIds: [9] })

    expect(open.value).toBe(true)
    expect(session.value).toBeNull()
    expect(error.value).toBe('None of the selected books have downloadable files')
  })

  it('opens the dialog without downloading when forced, even for a single part', async () => {
    mocks.api.mockResolvedValue(jsonResponse(makeSession({ parts: [makeSession().parts[0]!] })))
    const { useBulkDownload } = await import('../useBulkDownload')
    const { startBulkDownload, open, session } = useBulkDownload()

    await startBulkDownload({ query: { libraryId: 4 } }, 'primary', true)

    expect(open.value).toBe(true)
    expect(session.value?.parts).toHaveLength(1)
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it('ignores a slower response from a superseded prepare', async () => {
    let resolveFirst: (res: Response) => void = () => {}
    mocks.api
      .mockReturnValueOnce(new Promise<Response>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(jsonResponse(makeSession({ token: 'tok-audio', scope: 'audio' })))
    const { useBulkDownload } = await import('../useBulkDownload')
    const { startBulkDownload, prepare, scope, session, preparing } = useBulkDownload()

    const first = startBulkDownload({ query: { libraryId: 4 } }, 'primary', true)
    scope.value = 'audio'
    await prepare()
    resolveFirst(jsonResponse(makeSession({ token: 'tok-primary' })))
    await first

    expect(session.value?.token).toBe('tok-audio')
    expect(preparing.value).toBe(false)
    expect(JSON.parse(String(mocks.api.mock.calls[1]?.[1]?.body))).toMatchObject({ scope: 'audio' })
  })

  it('stays closed when the dialog is closed while preparing', async () => {
    let resolvePending: (res: Response) => void = () => {}
    mocks.api.mockReturnValueOnce(new Promise<Response>((resolve) => (resolvePending = resolve)))
    const { useBulkDownload } = await import('../useBulkDownload')
    const { startBulkDownload, close, open, session } = useBulkDownload()

    const pending = startBulkDownload({ query: { libraryId: 4 } }, 'primary', true)
    expect(open.value).toBe(true)
    close()
    resolvePending(jsonResponse(makeSession({ parts: [makeSession().parts[0]!] })))
    await pending

    expect(session.value).toBeNull()
    expect(mocks.download).not.toHaveBeenCalled()
    expect(open.value).toBe(false)
  })

  it('reports a generic error when the request itself fails', async () => {
    mocks.api.mockRejectedValue(new TypeError('network down'))
    const { useBulkDownload } = await import('../useBulkDownload')
    const { startBulkDownload, error, preparing, open } = useBulkDownload()

    await startBulkDownload({ bookIds: [1] })

    expect(error.value).toBe('')
    expect(preparing.value).toBe(false)
    expect(open.value).toBe(true)
  })

  it('falls back to a generic error when the failure body has no message', async () => {
    mocks.api.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }))
    const { useBulkDownload } = await import('../useBulkDownload')
    const { startBulkDownload, error } = useBulkDownload()

    await startBulkDownload({ bookIds: [1] })

    expect(error.value).toBe('')
  })

  it('does not download when re-preparing an expired session fails', async () => {
    mocks.api.mockResolvedValueOnce(jsonResponse(makeSession())).mockResolvedValueOnce(jsonResponse({ message: 'gone' }, 400))
    const { useBulkDownload } = await import('../useBulkDownload')
    const { startBulkDownload, downloadPart, error } = useBulkDownload()

    await startBulkDownload({ query: { libraryId: 4 } })
    vi.setSystemTime(new Date('2026-04-25T00:00:00.000Z'))
    await downloadPart(0)

    expect(mocks.download).not.toHaveBeenCalled()
    expect(error.value).toBe('gone')
  })

  it('does not download a part that no longer exists after re-preparing', async () => {
    mocks.api
      .mockResolvedValueOnce(jsonResponse(makeSession()))
      .mockResolvedValueOnce(jsonResponse(makeSession({ token: 'tok-2', parts: [makeSession().parts[0]!] })))
    const { useBulkDownload } = await import('../useBulkDownload')
    const { startBulkDownload, downloadPart } = useBulkDownload()

    await startBulkDownload({ query: { libraryId: 4 } })
    vi.setSystemTime(new Date('2026-04-25T00:00:00.000Z'))
    await downloadPart(1)

    expect(mocks.download).not.toHaveBeenCalled()
  })

  it('forgets started parts when the session is prepared again', async () => {
    mocks.api.mockImplementation(() => Promise.resolve(jsonResponse(makeSession())))
    const { useBulkDownload } = await import('../useBulkDownload')
    const { startBulkDownload, downloadPart, prepare, startedParts, nextPartIndex } = useBulkDownload()

    await startBulkDownload({ query: { libraryId: 4 } })
    await downloadPart(0)
    expect(startedParts.value.has(0)).toBe(true)
    await prepare()

    expect(startedParts.value.size).toBe(0)
    expect(nextPartIndex.value).toBe(0)
  })

  it('does nothing when there is no session or selection', async () => {
    const { useBulkDownload } = await import('../useBulkDownload')
    const { downloadPart, downloadNextPart, prepare } = useBulkDownload()

    await downloadPart(0)
    await downloadNextPart()
    await expect(prepare()).resolves.toBeNull()

    expect(mocks.api).not.toHaveBeenCalled()
    expect(mocks.download).not.toHaveBeenCalled()
  })

  describe('concurrent part limit', () => {
    const threeParts = () =>
      makeSession({
        parts: [0, 1, 2].map((index) => ({ index, bookCount: 1, fileCount: 1, bytes: 100, oversized: false })),
      })

    function routeApi(status: () => { activeParts: number[]; activeExports: number }) {
      mocks.api.mockImplementation((url: string) => Promise.resolve(jsonResponse(url.endsWith('/export/sessions') ? threeParts() : status())))
    }

    it('blocks a new part at the limit until the server reports one finished', async () => {
      let status = { activeParts: [0, 1], activeExports: 2 }
      routeApi(() => status)
      const { useBulkDownload } = await import('../useBulkDownload')
      const { startBulkDownload, downloadPart, atCapacity, activeParts } = useBulkDownload()

      await startBulkDownload({ query: { libraryId: 4 } })
      await downloadPart(0)
      await downloadPart(1)
      await downloadPart(2)
      expect(atCapacity.value).toBe(true)
      expect(mocks.download).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(2000)
      expect([...activeParts.value]).toEqual([0, 1])
      status = { activeParts: [1], activeExports: 1 }
      await vi.advanceTimersByTimeAsync(2000)

      expect(atCapacity.value).toBe(false)
      await downloadPart(2)
      expect(mocks.download).toHaveBeenLastCalledWith('/api/v1/books/export/sessions/tok-1/parts/2')
    })

    it('counts downloads from other sessions reported by the server', async () => {
      routeApi(() => ({ activeParts: [], activeExports: 2 }))
      const { useBulkDownload } = await import('../useBulkDownload')
      const { startBulkDownload, downloadPart, atCapacity } = useBulkDownload()

      await startBulkDownload({ query: { libraryId: 4 } })
      await vi.advanceTimersByTimeAsync(2000)
      await downloadPart(0)

      expect(atCapacity.value).toBe(true)
      expect(mocks.download).not.toHaveBeenCalled()
    })

    it('does not start a part that is already downloading', async () => {
      routeApi(() => ({ activeParts: [], activeExports: 0 }))
      const { useBulkDownload } = await import('../useBulkDownload')
      const { startBulkDownload, downloadPart } = useBulkDownload()

      await startBulkDownload({ query: { libraryId: 4 } })
      await downloadPart(0)
      await downloadPart(0)

      expect(mocks.download).toHaveBeenCalledTimes(1)
    })

    it('frees a launched part the server never picked up after the grace period', async () => {
      routeApi(() => ({ activeParts: [], activeExports: 0 }))
      const { useBulkDownload } = await import('../useBulkDownload')
      const { startBulkDownload, downloadPart, atCapacity, activeParts } = useBulkDownload()

      await startBulkDownload({ query: { libraryId: 4 } })
      await downloadPart(0)
      await downloadPart(1)
      expect(atCapacity.value).toBe(true)

      await vi.advanceTimersByTimeAsync(12_000)

      expect(atCapacity.value).toBe(false)
      expect(activeParts.value.size).toBe(0)
    })

    it('polls only while the dialog is open', async () => {
      routeApi(() => ({ activeParts: [], activeExports: 0 }))
      const { useBulkDownload } = await import('../useBulkDownload')
      const { startBulkDownload, close } = useBulkDownload()

      await startBulkDownload({ query: { libraryId: 4 } })
      await vi.advanceTimersByTimeAsync(4000)
      const statusCalls = () => mocks.api.mock.calls.filter(([url]) => url === '/api/v1/books/export/sessions/tok-1').length
      expect(statusCalls()).toBe(2)

      close()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(statusCalls()).toBe(2)
    })

    it('keeps the last known status when a poll fails', async () => {
      let fail = false
      routeApi(() => {
        if (fail) throw new TypeError('offline')
        return { activeParts: [0], activeExports: 2 }
      })
      const { useBulkDownload } = await import('../useBulkDownload')
      const { startBulkDownload, atCapacity } = useBulkDownload()

      await startBulkDownload({ query: { libraryId: 4 } })
      await vi.advanceTimersByTimeAsync(2000)
      fail = true
      await vi.advanceTimersByTimeAsync(2000)

      expect(atCapacity.value).toBe(true)
    })
  })
})
