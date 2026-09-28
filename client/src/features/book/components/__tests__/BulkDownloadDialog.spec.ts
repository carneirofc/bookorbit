import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { BookExportSessionResponse } from '@bookorbit/types'
import BulkDownloadDialog from '../BulkDownloadDialog.vue'
import { useBulkDownload } from '@/features/book/composables/useBulkDownload'

const mocks = vi.hoisted(() => ({
  api: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
  download: vi.fn<(url: string) => void>(),
}))

vi.mock('@/lib/api', () => ({ api: mocks.api }))
vi.mock('@/lib/browserDownload', () => ({ triggerBrowserDownload: mocks.download }))

const GB = 1024 * 1024 * 1024

function makeSession(overrides: Partial<BookExportSessionResponse> = {}): BookExportSessionResponse {
  return {
    token: 'tok',
    scope: 'primary',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    bookCount: 1200,
    skippedBookCount: 2,
    totalBytes: 3 * GB,
    parts: [
      { index: 0, bookCount: 700, fileCount: 700, bytes: GB, oversized: false },
      { index: 1, bookCount: 499, fileCount: 499, bytes: GB, oversized: false },
      { index: 2, bookCount: 1, fileCount: 1, bytes: GB, oversized: true },
    ],
    maxConcurrentExports: 3,
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function query<T extends Element = HTMLElement>(testId: string): T {
  const el = document.querySelector<T>(`[data-testid="${testId}"]`)
  if (!el) throw new Error(`missing ${testId}`)
  return el
}

let mounted: VueWrapper | null = null

function mountDialog() {
  mounted = mount(BulkDownloadDialog, { attachTo: document.body })
  return mounted
}

async function openWith(session: BookExportSessionResponse) {
  mocks.api.mockImplementation(() => Promise.resolve(jsonResponse(session)))
  const wrapper = mountDialog()
  await useBulkDownload().startBulkDownload({ query: { libraryId: 4 } }, 'primary', true)
  await flushPromises()
  return wrapper
}

describe('BulkDownloadDialog', () => {
  beforeEach(() => {
    mocks.api.mockReset()
    mocks.download.mockReset()
  })

  afterEach(async () => {
    useBulkDownload().close()
    useBulkDownload().partSizeMb.value = 1024
    await flushPromises()
    mounted?.unmount()
    mounted = null
    document.body.innerHTML = ''
  })

  it('renders the session summary and one row per part', async () => {
    const wrapper = await openWith(makeSession())

    const summary = query('bulk-download-summary').textContent ?? ''
    expect(summary).toContain('1,200 books in 3 parts')
    expect(summary).toContain('2 books have no matching files')
    expect(document.querySelectorAll('[data-testid="bulk-download-parts"] li')).toHaveLength(3)
    expect(document.body.textContent).toContain('Larger than the part size')
    expect(query('bulk-download-next').textContent).toContain('Part 1 of 3')
    wrapper.unmount()
  })

  it('re-prepares with the chosen scope and part size', async () => {
    const wrapper = await openWith(makeSession())

    const scope = query<HTMLSelectElement>('bulk-download-scope')
    scope.value = 'audio'
    scope.dispatchEvent(new Event('change'))
    await flushPromises()
    const partSize = query<HTMLSelectElement>('bulk-download-part-size')
    partSize.value = '500'
    partSize.dispatchEvent(new Event('change'))
    await flushPromises()

    const bodies = mocks.api.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies).toEqual([
      { query: { libraryId: 4 }, scope: 'primary', partSizeMb: 1024 },
      { query: { libraryId: 4 }, scope: 'audio', partSizeMb: 1024 },
      { query: { libraryId: 4 }, scope: 'audio', partSizeMb: 500 },
    ])
    wrapper.unmount()
  })

  it('downloads parts from the row buttons and the next-part button', async () => {
    const wrapper = await openWith(makeSession())

    query('bulk-download-part-1').click()
    await flushPromises()
    expect(query('bulk-download-part-1').textContent).toContain('Downloading...')
    expect(query('bulk-download-next').textContent).toContain('Part 1 of 3')

    query('bulk-download-next').click()
    await flushPromises()
    query('bulk-download-next').click()
    await flushPromises()

    expect(mocks.download.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/books/export/sessions/tok/parts/1',
      '/api/v1/books/export/sessions/tok/parts/0',
      '/api/v1/books/export/sessions/tok/parts/2',
    ])
    const next = query<HTMLButtonElement>('bulk-download-next')
    expect(next.disabled).toBe(true)
    expect(next.textContent).toContain('All parts started')
    expect(document.body.textContent).toContain('Done')
    wrapper.unmount()
  })

  it('locks the remaining parts while the concurrent limit is in use', async () => {
    const wrapper = await openWith(makeSession({ maxConcurrentExports: 1 }))
    expect(document.querySelector('[data-testid="bulk-download-at-capacity"]')).toBeNull()

    query('bulk-download-part-0').click()
    await flushPromises()

    const current = query<HTMLButtonElement>('bulk-download-part-0')
    expect(current.disabled).toBe(true)
    expect(current.textContent).toContain('Downloading...')
    expect(query<HTMLButtonElement>('bulk-download-part-1').disabled).toBe(true)
    expect(query<HTMLButtonElement>('bulk-download-next').disabled).toBe(true)
    expect(query('bulk-download-at-capacity').textContent).toContain('1 part is already downloading')
    expect(mocks.download).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('is an accessible dialog that closes on Escape', async () => {
    const wrapper = await openWith(makeSession())

    const dialog = query('bulk-download-dialog')
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()

    expect(document.querySelector('[data-testid="bulk-download-dialog"]')).toBeNull()
    expect(useBulkDownload().open.value).toBe(false)
    wrapper.unmount()
  })

  it('shows the server error, or a fallback when there is none', async () => {
    mocks.api.mockResolvedValueOnce(jsonResponse({ message: 'None of the selected books have downloadable files' }, 400))
    const wrapper = mountDialog()
    await useBulkDownload().startBulkDownload({ bookIds: [1] })
    await flushPromises()
    expect(document.body.textContent).toContain('None of the selected books have downloadable files')
    expect(query<HTMLButtonElement>('bulk-download-next').disabled).toBe(true)

    mocks.api.mockRejectedValueOnce(new TypeError('offline'))
    await useBulkDownload().prepare()
    await flushPromises()
    expect(document.body.textContent).toContain('Failed to prepare download')
    wrapper.unmount()
  })

  it('disables the options while preparing', async () => {
    mocks.api.mockReturnValue(new Promise<Response>(() => {}))
    const wrapper = mountDialog()
    void useBulkDownload().startBulkDownload({ query: { libraryId: 4 } }, 'primary', true)
    await flushPromises()

    expect(document.body.textContent).toContain('Preparing download...')
    expect(query<HTMLSelectElement>('bulk-download-scope').disabled).toBe(true)
    expect(query<HTMLSelectElement>('bulk-download-part-size').disabled).toBe(true)
    expect(query<HTMLButtonElement>('bulk-download-next').disabled).toBe(true)
    wrapper.unmount()
  })

  it('closes from the header button', async () => {
    const wrapper = await openWith(makeSession())

    document.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click()
    await flushPromises()

    expect(document.querySelector('[data-testid="bulk-download-dialog"]')).toBeNull()
    expect(useBulkDownload().session.value).toBeNull()
    wrapper.unmount()
  })
})
