import { describe, it, expect, vi, beforeEach } from 'vitest'

const api = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>())
vi.mock('@/lib/api', () => ({ api }))

import { fileExtension, useReplaceBookFile } from '../useReplaceBookFile'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('useReplaceBookFile', () => {
  beforeEach(() => {
    api.mockReset()
  })

  it('sends the file as multipart to PUT /books/:id/files/:fileId', async () => {
    const result = { id: 12, bookId: 7, format: 'epub', sizeBytes: 3, filename: 'fic.epub', isPrimary: true }
    api.mockResolvedValue(jsonResponse(200, result))
    const { replaceFile, replacing, error } = useReplaceBookFile()

    const file = new File(['abc'], 'fic-v2.epub')
    await expect(replaceFile(7, 12, file, 'fallback')).resolves.toEqual(result)

    const [url, init] = api.mock.calls[0]!
    expect(url).toBe('/api/v1/books/7/files/12')
    expect(init?.method).toBe('PUT')
    expect((init!.body as FormData).get('file')).toBeInstanceOf(File)
    expect(replacing.value).toBe(false)
    expect(error.value).toBeNull()
  })

  it('surfaces the server message on failure', async () => {
    api.mockResolvedValue(jsonResponse(400, { message: 'Replacement must be a .epub file to match the current file' }))
    const { replaceFile, error } = useReplaceBookFile()

    await expect(replaceFile(7, 12, new File(['x'], 'fic.pdf'), 'fallback')).resolves.toBeNull()
    expect(error.value).toBe('Replacement must be a .epub file to match the current file')
  })

  it('falls back to the provided message when the body has none', async () => {
    api.mockResolvedValue(new Response('', { status: 500 }))
    const { replaceFile, error } = useReplaceBookFile()

    await replaceFile(7, 12, new File(['x'], 'fic.epub'), 'fallback')
    expect(error.value).toBe('fallback')
  })

  it('reads the lower-cased extension', () => {
    expect(fileExtension('Story.EPUB')).toBe('epub')
  })
})
