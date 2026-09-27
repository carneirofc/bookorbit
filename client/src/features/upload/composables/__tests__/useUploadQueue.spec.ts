import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'

vi.mock('@/lib/api', () => ({ getValidToken: vi.fn<() => Promise<string>>().mockResolvedValue('token') }))

const { uploadFileInChunks, cancelChunkedUpload } = vi.hoisted(() => ({
  uploadFileInChunks: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  cancelChunkedUpload: vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
}))

vi.mock('../useChunkedUploader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../useChunkedUploader')>()
  return { ...actual, uploadFileInChunks, cancelChunkedUpload }
})

import { useUploadQueue, type UploadTarget } from '../useUploadQueue'

function fileOf(name: string, size = 1000): File {
  return new File([new Uint8Array(size)], name)
}

function makeTarget(overrides: Partial<UploadTarget<{ id: number }>> = {}): UploadTarget<{ id: number }> {
  return {
    url: '/api/v1/book-dock/upload',
    cancelUrl: '/api/v1/book-dock/upload',
    validate: (file) => (file.name.endsWith('.epub') ? null : `Unsupported type`),
    ...overrides,
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('useUploadQueue', () => {
  beforeEach(() => {
    useUploadQueue().clearAll()
    uploadFileInChunks.mockReset()
    uploadFileInChunks.mockResolvedValue({ id: 1 })
    cancelChunkedUpload.mockClear()
  })

  describe('validation feedback', () => {
    it('keeps a rejected file in the queue as a visible error row', async () => {
      const queue = useUploadQueue(makeTarget())

      queue.addFiles([fileOf('notes.txt')])

      expect(queue.items.value).toHaveLength(1)
      expect(queue.items.value[0]).toMatchObject({ status: 'error', validationError: true, error: 'Unsupported type' })
      expect(uploadFileInChunks).not.toHaveBeenCalled()
    })

    it('does not offer a retry that could never succeed', async () => {
      const queue = useUploadQueue(makeTarget())
      queue.addFiles([fileOf('notes.txt')])

      queue.retry(queue.items.value[0].id)
      await flush()

      expect(queue.items.value[0].status).toBe('error')
      expect(uploadFileInChunks).not.toHaveBeenCalled()
    })

    it('opens the tray when files are queued', () => {
      const queue = useUploadQueue(makeTarget())
      queue.trayDismissed.value = true

      queue.addFiles([fileOf('dune.epub')])

      expect(queue.trayOpen.value).toBe(true)
      expect(queue.trayDismissed.value).toBe(false)
    })
  })

  describe('upload lifecycle', () => {
    it('marks a file done and records the server result', async () => {
      const onFileDone = vi.fn<(item: unknown) => void>()
      const queue = useUploadQueue(makeTarget({ onFileDone }))
      uploadFileInChunks.mockResolvedValue({ id: 55 })

      queue.addFiles([fileOf('dune.epub')])
      await flush()

      expect(queue.items.value[0]).toMatchObject({ status: 'done', progress: 100, result: { id: 55 } })
      expect(onFileDone).toHaveBeenCalledTimes(1)
    })

    it('surfaces the server message on failure', async () => {
      const queue = useUploadQueue(makeTarget())
      uploadFileInChunks.mockRejectedValue({ message: 'File contents do not match', errorCode: 'content_type_mismatch', status: 422 })

      queue.addFiles([fileOf('dune.epub')])
      await flush()

      expect(queue.items.value[0]).toMatchObject({ status: 'error', error: 'File contents do not match', errorCode: 'content_type_mismatch' })
    })

    it('runs at most three files at once', async () => {
      const queue = useUploadQueue(makeTarget())
      let peak = 0
      let inFlight = 0
      uploadFileInChunks.mockImplementation(async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight--
        return { id: 1 }
      })

      queue.addFiles(Array.from({ length: 8 }, (_, i) => fileOf(`book-${i}.epub`)))
      await new Promise((resolve) => setTimeout(resolve, 120))

      expect(peak).toBeLessThanOrEqual(3)
      expect(queue.items.value.every((i) => i.status === 'done')).toBe(true)
    })

    it('gives a retried file a fresh upload id, since the old session is gone', async () => {
      const queue = useUploadQueue(makeTarget())
      uploadFileInChunks.mockRejectedValueOnce({ message: 'boom', status: 500 })

      queue.addFiles([fileOf('dune.epub')])
      await flush()
      const firstUploadId = queue.items.value[0].uploadId

      queue.retry(queue.items.value[0].id)
      await flush()

      expect(queue.items.value[0].uploadId).not.toBe(firstUploadId)
      expect(queue.items.value[0].status).toBe('done')
    })
  })

  describe('held files', () => {
    it('does not start held files until they are released', async () => {
      const queue = useUploadQueue(makeTarget())

      queue.addFiles([fileOf('dune.epub')], { hold: true })
      await flush()

      expect(uploadFileInChunks).not.toHaveBeenCalled()
      expect(queue.items.value[0].status).toBe('pending')
    })

    it('rebinds released files to the target chosen at start time', async () => {
      const queue = useUploadQueue(makeTarget())
      const ids = queue.addFiles([fileOf('dune.epub')], { hold: true })

      await queue.release(ids, { url: '/api/v1/libraries/3/upload', cancelUrl: '/api/v1/libraries/3/upload' })

      expect(uploadFileInChunks).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/v1/libraries/3/upload' }))
      expect(queue.items.value[0].status).toBe('done')
    })

    it('resolves release only once every released file has settled', async () => {
      const queue = useUploadQueue(makeTarget())
      let settled = false
      uploadFileInChunks.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { id: 1 }
      })

      const ids = queue.addFiles([fileOf('a.epub'), fileOf('b.epub')], { hold: true })
      const done = queue.release(ids).then(() => {
        settled = true
      })

      expect(settled).toBe(false)
      await done
      expect(queue.items.value.every((i) => i.status === 'done')).toBe(true)
    })
  })

  describe('cancellation', () => {
    it('cancels a queued file and tells the server to drop its partial data', () => {
      const queue = useUploadQueue(makeTarget())
      const ids = queue.addFiles([fileOf('dune.epub')], { hold: true })

      queue.cancel(ids[0])

      expect(queue.items.value[0].status).toBe('canceled')
      expect(cancelChunkedUpload).toHaveBeenCalledWith('/api/v1/book-dock/upload', expect.any(String))
    })

    it('drops finished and canceled rows but keeps failures visible', async () => {
      const queue = useUploadQueue(makeTarget())
      uploadFileInChunks.mockRejectedValueOnce({ message: 'boom', status: 500 })

      queue.addFiles([fileOf('bad.epub')])
      await flush()
      queue.addFiles([fileOf('good.epub')])
      await flush()

      queue.clearFinished()

      expect(queue.items.value).toHaveLength(1)
      expect(queue.items.value[0].status).toBe('error')
    })
  })

  describe('reactivity', () => {
    it('propagates progress and completion to computed views after the upload starts', async () => {
      let reportProgress: (loaded: number) => void = () => {}
      let finish: (value: unknown) => void = () => {}
      uploadFileInChunks.mockImplementation((opts) => {
        const { onProgress } = opts as { onProgress: (p: { loadedBytes: number; totalBytes: number }) => void }
        reportProgress = (loaded) => onProgress({ loadedBytes: loaded, totalBytes: 1000 })
        return new Promise((resolve) => {
          finish = resolve
        })
      })

      const queue = useUploadQueue(makeTarget())
      const view = computed(() => queue.items.value.map((i) => `${i.status}:${i.progress}`).join(','))

      queue.addFiles([fileOf('a.epub')])
      await flush()
      expect(view.value).toBe('uploading:0')

      reportProgress(400)
      expect(view.value).toBe('uploading:40')
      expect(queue.overallProgress.value).toBe(40)

      finish({ id: 1 })
      await flush()
      expect(view.value).toBe('done:100')
      expect(queue.isUploading.value).toBe(false)
    })
  })

  describe('tray visibility', () => {
    it('reopens and expands a dismissed tray on demand', () => {
      const queue = useUploadQueue(makeTarget())
      queue.trayDismissed.value = true
      queue.trayCollapsed.value = true

      queue.showTray()

      expect(queue.trayDismissed.value).toBe(false)
      expect(queue.trayCollapsed.value).toBe(false)
      expect(queue.trayOpen.value).toBe(true)
    })
  })
})
