import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import BookDockUploadFailures from '../BookDockUploadFailures.vue'
import { useBookDockUpload } from '../../composables/useBookDockUpload'
import { UploadSessionError } from '@/features/upload/uploadSession'

const { calls, uploadViaSessionMock } = vi.hoisted(() => {
  const calls: Array<{ file: File; reject: (err: unknown) => void }> = []
  const uploadViaSessionMock = vi.fn<(options: { file: File }) => Promise<never>>(
    (options) =>
      new Promise<never>((_resolve, reject) => {
        calls.push({ file: options.file, reject })
      }),
  )
  return { calls, uploadViaSessionMock }
})

vi.mock('@/features/upload/uploadSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/upload/uploadSession')>()),
  uploadViaSession: uploadViaSessionMock,
}))

function book(name: string): File {
  return new File([new Uint8Array(8)], name)
}

async function failWithServerError(name: string, status: number, message: string) {
  const upload = useBookDockUpload()
  upload.addFiles([book(name)])
  await flushPromises()
  calls.at(-1)?.reject(new UploadSessionError(message, status, undefined, message, true))
  await flushPromises()
}

beforeEach(() => {
  useBookDockUpload().clearAll()
  calls.length = 0
  uploadViaSessionMock.mockClear()
})

describe('BookDockUploadFailures', () => {
  it('renders nothing while no upload has failed', () => {
    const wrapper = mount(BookDockUploadFailures)

    expect(wrapper.find('[data-testid="book-dock-upload-failures"]').exists()).toBe(false)
  })

  it('names each failed file with its reason', async () => {
    const wrapper = mount(BookDockUploadFailures)

    useBookDockUpload().addFiles([book('notes.docx'), book('README')])
    await flushPromises()

    const rows = wrapper.findAll('li').map((row) => row.text())
    expect(rows).toEqual([expect.stringContaining('notes.docx'), expect.stringContaining('README')])
    expect(rows[0]).toContain('Unsupported file type: .docx')
    expect(rows[1]).toContain('The file has no extension, so its format is unknown')
  })

  it('shows the server message when the server gave a reason the client cannot translate', async () => {
    const wrapper = mount(BookDockUploadFailures)

    await failWithServerError('dune.epub', 500, 'EACCES: permission denied, open /books/dune.epub')

    expect(wrapper.get('li').text()).toContain('EACCES: permission denied, open /books/dune.epub')
  })

  it('announces the failure count through an alert inside the heading', async () => {
    const wrapper = mount(BookDockUploadFailures)

    useBookDockUpload().addFiles([book('a.docx')])
    await flushPromises()
    expect(wrapper.get('h2 [role="alert"]').text()).toBe('Could not upload 1 file')

    useBookDockUpload().addFiles([book('b.docx')])
    await flushPromises()
    expect(wrapper.get('h2 [role="alert"]').text()).toBe('Could not upload 2 files')
    expect(wrapper.get('section').attributes('aria-labelledby')).toBe(wrapper.get('h2').attributes('id'))
  })

  it('offers retry only where retrying can help', async () => {
    const wrapper = mount(BookDockUploadFailures)

    useBookDockUpload().addFiles([book('notes.docx')])
    await failWithServerError('dune.epub', 503, 'Service unavailable')

    expect(wrapper.findAll('button[aria-label^="Retry uploading"]').map((b) => b.attributes('aria-label'))).toEqual(['Retry uploading dune.epub'])
  })

  it('re-sends the file when retry is pressed', async () => {
    const wrapper = mount(BookDockUploadFailures)
    await failWithServerError('dune.epub', 503, 'Service unavailable')

    await wrapper.get('button[aria-label="Retry uploading dune.epub"]').trigger('click')
    await flushPromises()

    expect(calls).toHaveLength(2)
    expect(wrapper.find('[data-testid="book-dock-upload-failures"]').exists()).toBe(false)
  })

  it('dismisses a single failure', async () => {
    const wrapper = mount(BookDockUploadFailures)
    useBookDockUpload().addFiles([book('a.docx'), book('b.docx')])
    await flushPromises()

    await wrapper.get('button[aria-label="Dismiss a.docx"]').trigger('click')

    expect(wrapper.findAll('li').map((row) => row.find('p').text())).toEqual(['b.docx'])
  })

  it('offers dismiss all only when more than one upload failed', async () => {
    const wrapper = mount(BookDockUploadFailures)
    useBookDockUpload().addFiles([book('a.docx')])
    await flushPromises()
    expect(wrapper.find('[data-testid="book-dock-upload-failures-dismiss-all"]').exists()).toBe(false)

    useBookDockUpload().addFiles([book('b.docx')])
    await flushPromises()
    await wrapper.get('[data-testid="book-dock-upload-failures-dismiss-all"]').trigger('click')

    expect(wrapper.find('[data-testid="book-dock-upload-failures"]').exists()).toBe(false)
  })

  it('gives every icon button an accessible name that includes the file', async () => {
    const wrapper = mount(BookDockUploadFailures)
    useBookDockUpload().addFiles([book('notes.docx')])
    await flushPromises()

    const iconButtons = wrapper.findAll('li button')
    expect(iconButtons.map((b) => b.attributes('aria-label'))).toEqual(['Dismiss notes.docx'])
    expect(iconButtons.every((b) => b.attributes('type') === 'button')).toBe(true)
  })
})
