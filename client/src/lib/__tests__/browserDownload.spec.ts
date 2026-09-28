import { afterEach, describe, expect, it, vi } from 'vitest'
import { triggerBrowserDownload } from '../browserDownload'

describe('triggerBrowserDownload', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('clicks a temporary anchor pointing at the url and removes it', () => {
    const clicked: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this)
    })

    triggerBrowserDownload('/api/v1/books/export/sessions/tok/parts/0')

    expect(clicked).toHaveLength(1)
    expect(clicked[0]?.getAttribute('href')).toBe('/api/v1/books/export/sessions/tok/parts/0')
    expect(clicked[0]?.rel).toBe('noopener')
    expect(clicked[0]?.hasAttribute('download')).toBe(false)
    expect(document.querySelector('a')).toBeNull()
  })

  it('sets the download filename when given', () => {
    const clicked: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this)
    })

    triggerBrowserDownload('/file', 'book.epub')

    expect(clicked[0]?.download).toBe('book.epub')
  })
})
