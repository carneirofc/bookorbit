import { flushPromises } from '@vue/test-utils'
import type { UploadSessionResponse, UploadTarget } from '@bookorbit/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface SessionCall {
  file: File
  target: UploadTarget
  onProgress?: (percent: number) => void
  resolve: () => void
  reject: (err: unknown) => void
}

const { calls, uploadViaSessionMock } = vi.hoisted(() => {
  const calls: SessionCall[] = []
  type Options = { file: File; target: UploadTarget; onProgress?: (percent: number) => void }
  const uploadViaSessionMock = vi.fn<(options: Options) => Promise<UploadSessionResponse>>(
    (options) =>
      new Promise<UploadSessionResponse>((resolve, reject) => {
        calls.push({ ...options, resolve: () => resolve({} as UploadSessionResponse), reject })
      }),
  )
  return { calls, uploadViaSessionMock }
})

vi.mock('@/features/upload/uploadSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/upload/uploadSession')>()),
  uploadViaSession: uploadViaSessionMock,
}))

const MB = 1024 * 1024

function book(name: string, sizeBytes = 16): File {
  return new File([new Uint8Array(sizeBytes)], name, { type: 'application/epub+zip' })
}

// Modules are reset per test, so the error class must come from the same load as the composable.
let UploadSessionError: typeof import('@/features/upload/uploadSession').UploadSessionError

function serverError(status: number, serverMessage: string | null, errorCode?: string, fromBookOrbit = true) {
  return new UploadSessionError(serverMessage ?? `Upload failed (${status})`, status, errorCode, serverMessage, fromBookOrbit)
}

async function loadComposable() {
  const module = await import('../useBookDockUpload')
  const { useAppInfo } = await import('@/features/settings/composables/useAppInfo')
  ;({ UploadSessionError } = await import('@/features/upload/uploadSession'))
  return { upload: module.useBookDockUpload(), useBookDockUpload: module.useBookDockUpload, appInfo: useAppInfo() }
}

beforeEach(() => {
  vi.resetModules()
  calls.length = 0
  uploadViaSessionMock.mockClear()
})

describe('useBookDockUpload client-side validation', () => {
  it('records an unsupported file as a failure without sending it', async () => {
    const { upload } = await loadComposable()

    upload.addFiles([book('notes.docx')])
    await flushPromises()

    expect(calls).toHaveLength(0)
    expect(upload.failures.value.map((f) => f.failure)).toEqual([{ kind: 'unsupported', extension: 'docx' }])
    expect(upload.isUploading.value).toBe(false)
  })

  it('records a file with no extension as unsupported', async () => {
    const { upload } = await loadComposable()

    upload.addFiles([book('README')])

    expect(upload.failures.value[0]?.failure).toEqual({ kind: 'unsupported', extension: '' })
  })

  it('accepts a supported extension regardless of case', async () => {
    const { upload } = await loadComposable()

    upload.addFiles([book('Dune.EPUB')])
    await flushPromises()

    expect(calls).toHaveLength(1)
    expect(upload.failures.value).toHaveLength(0)
  })

  it('sends DjVu to the Book Dock instead of rejecting it as unsupported', async () => {
    const { upload } = await loadComposable()
    upload.addFiles([book('DjVuLibre-book.DJVU')])
    await flushPromises()
    expect(calls).toHaveLength(1)
    expect(upload.failures.value).toHaveLength(0)
  })

  it('rejects a file over the configured upload limit before sending it', async () => {
    const { upload, appInfo } = await loadComposable()
    appInfo.maxUploadSizeMb.value = 1

    upload.addFiles([book('huge.epub', 2 * MB)])
    await flushPromises()

    expect(calls).toHaveLength(0)
    expect(upload.failures.value[0]?.failure).toEqual({ kind: 'tooLarge', limitBytes: MB })
  })

  it('sends the valid files of a mixed selection and reports only the invalid one', async () => {
    const { upload } = await loadComposable()

    upload.addFiles([book('good.epub'), book('cover.jpg')])
    await flushPromises()

    expect(calls).toHaveLength(1)
    expect(upload.failures.value.map((f) => f.file.name)).toEqual(['cover.jpg'])
  })
})

describe('useBookDockUpload requests', () => {
  it('sends the file to the Book Dock through an upload session', async () => {
    const { upload } = await loadComposable()
    const file = book('dune.epub')

    upload.addFiles([file])
    await flushPromises()

    expect(calls[0]?.file).toBe(file)
    expect(calls[0]?.target).toEqual({ kind: 'book_dock' })
    expect(upload.isUploading.value).toBe(true)
  })

  it('reports upload progress while the file is sending', async () => {
    const { upload } = await loadComposable()

    upload.addFiles([book('dune.epub')])
    await flushPromises()
    calls[0]?.onProgress?.(25)

    expect(upload.files.value[0]?.status).toBe('uploading')
    expect(upload.files.value[0]?.progress).toBe(25)
  })

  it('drops a file from the queue once the server accepts it', async () => {
    const { upload } = await loadComposable()

    upload.addFiles([book('dune.epub')])
    await flushPromises()
    calls[0]?.resolve()
    await flushPromises()

    expect(upload.files.value).toHaveLength(0)
    expect(upload.failures.value).toHaveLength(0)
    expect(upload.isUploading.value).toBe(false)
  })

  it('uploads at most three files at a time and finishes the rest', async () => {
    const { upload } = await loadComposable()

    upload.addFiles(['a', 'b', 'c', 'd', 'e'].map((name) => book(`${name}.epub`)))
    await flushPromises()
    expect(calls).toHaveLength(3)

    for (const call of calls) call.resolve()
    await flushPromises()
    expect(calls).toHaveLength(5)

    for (const call of calls.slice(3)) call.resolve()
    await flushPromises()
    expect(upload.files.value).toHaveLength(0)
    expect(upload.isUploading.value).toBe(false)
  })

  it('keeps going with the rest of a batch after one upload fails', async () => {
    const { upload } = await loadComposable()

    upload.addFiles([book('a.epub'), book('b.epub'), book('c.epub')])
    await flushPromises()
    calls[0]?.reject(serverError(500, 'Internal server error'))
    calls[1]?.resolve()
    calls[2]?.resolve()
    await flushPromises()

    expect(upload.failures.value.map((f) => f.file.name)).toEqual(['a.epub'])
    expect(upload.files.value).toHaveLength(1)
    expect(upload.isUploading.value).toBe(false)
  })
})

describe('useBookDockUpload server failures', () => {
  it('keeps the error code and message from a BookOrbit rejection', async () => {
    const { upload } = await loadComposable()

    upload.addFiles([book('dune.epub')])
    await flushPromises()
    calls[0]?.reject(serverError(413, 'File exceeds the 1 MB upload limit', 'UPLOAD_TOO_LARGE'))
    await flushPromises()

    expect(upload.failures.value[0]?.failure).toEqual({
      kind: 'server',
      status: 413,
      errorCode: 'UPLOAD_TOO_LARGE',
      message: 'File exceeds the 1 MB upload limit',
      fromBookOrbit: true,
    })
  })

  it('marks an error page from in front of BookOrbit as such', async () => {
    const { upload } = await loadComposable()

    upload.addFiles([book('dune.epub')])
    await flushPromises()
    calls[0]?.reject(serverError(413, null, undefined, false))
    await flushPromises()

    expect(upload.failures.value[0]?.failure).toEqual({ kind: 'server', status: 413, errorCode: null, message: null, fromBookOrbit: false })
  })
})

describe('useBookDockUpload requests that never complete', () => {
  it('records a dropped connection as a network failure and keeps the queue moving', async () => {
    const { upload } = await loadComposable()

    upload.addFiles([book('a.epub')])
    await flushPromises()
    calls[0]?.reject(serverError(0, null, undefined, false))
    await flushPromises()

    expect(upload.failures.value[0]?.failure).toEqual({ kind: 'network' })
    expect(upload.isUploading.value).toBe(false)

    upload.addFiles([book('b.epub')])
    await flushPromises()
    expect(calls).toHaveLength(2)
  })

  it('fails the file instead of hanging when the request cannot be made', async () => {
    const { upload } = await loadComposable()

    upload.addFiles([book('a.epub')])
    await flushPromises()
    calls[0]?.reject(new TypeError('Failed to fetch'))
    await flushPromises()

    expect(upload.failures.value[0]?.failure).toEqual({ kind: 'network' })
    expect(upload.isUploading.value).toBe(false)
  })
})

describe('useBookDockUpload retry and dismiss', () => {
  it('retries a transient failure and clears it once the upload succeeds', async () => {
    const { upload } = await loadComposable()

    upload.addFiles([book('a.epub')])
    await flushPromises()
    calls[0]?.reject(serverError(503, 'Service unavailable'))
    await flushPromises()
    const id = upload.failures.value[0]!.id

    upload.retryFailure(id)
    await flushPromises()
    expect(calls).toHaveLength(2)
    expect(upload.failures.value).toHaveLength(0)

    calls[1]?.resolve()
    await flushPromises()
    expect(upload.files.value).toHaveLength(0)
  })

  it('picks up a retry while another upload is still in flight', async () => {
    const { upload } = await loadComposable()

    upload.addFiles([book('a.epub')])
    await flushPromises()
    calls[0]?.reject(new TypeError('Failed to fetch'))
    await flushPromises()
    upload.addFiles([book('b.epub')])
    await flushPromises()

    upload.retryFailure(upload.failures.value[0]!.id)
    calls[1]?.resolve()
    await flushPromises()

    expect(calls).toHaveLength(3)
    expect(calls[2]?.file.name).toBe('a.epub')
  })

  it('refuses to retry failures that would fail the same way again', async () => {
    const { upload } = await loadComposable()

    upload.addFiles([book('notes.docx'), book('a.epub')])
    await flushPromises()
    calls[0]?.reject(serverError(413, 'File exceeds the 1 MB upload limit', 'UPLOAD_TOO_LARGE'))
    await flushPromises()

    for (const failure of upload.failures.value) upload.retryFailure(failure.id)
    await flushPromises()

    expect(calls).toHaveLength(1)
    expect(upload.failures.value).toHaveLength(2)
  })

  it('ignores a retry for an unknown id', async () => {
    const { upload } = await loadComposable()

    upload.retryFailure('missing')
    await flushPromises()

    expect(calls).toHaveLength(0)
    expect(upload.isUploading.value).toBe(false)
  })

  it('dismisses one failure or all of them', async () => {
    const { upload } = await loadComposable()

    upload.addFiles([book('a.docx'), book('b.docx'), book('c.docx')])
    upload.dismissFailure(upload.failures.value[0]!.id)
    expect(upload.failures.value.map((f) => f.file.name)).toEqual(['b.docx', 'c.docx'])

    upload.dismissAllFailures()
    expect(upload.failures.value).toHaveLength(0)
  })

  it('never dismisses an upload that is still in flight', async () => {
    const { upload } = await loadComposable()

    upload.addFiles([book('a.epub'), book('b.docx')])
    await flushPromises()
    const inFlight = upload.files.value.find((f) => f.status === 'uploading')!

    upload.dismissFailure(inFlight.id)
    upload.dismissAllFailures()

    expect(upload.files.value.map((f) => f.id)).toEqual([inFlight.id])
  })

  it('shares failures between every caller, such as the toolbar and the page', async () => {
    const { upload, useBookDockUpload } = await loadComposable()
    const other = useBookDockUpload()

    upload.addFiles([book('notes.docx')])

    expect(other.failures.value).toHaveLength(1)
    other.dismissAllFailures()
    expect(upload.failures.value).toHaveLength(0)
  })
})
