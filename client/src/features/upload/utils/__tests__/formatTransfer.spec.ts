import { describe, expect, it } from 'vitest'

import { formatBytes, formatEta, formatSpeed } from '../formatTransfer'

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [-5, '0 B'],
    [512, '512 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [150 * 1024, '150 KB'],
    [16 * 1024 * 1024, '16.0 MB'],
    [1024 ** 3 * 1.4, '1.4 GB'],
  ])('renders %i bytes as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  it('does not run past the largest unit it knows', () => {
    expect(formatBytes(1024 ** 6)).toMatch(/TB$/)
  })
})

describe('formatSpeed', () => {
  it('appends a per-second suffix', () => {
    expect(formatSpeed(4.2 * 1024 * 1024)).toBe('4.2 MB/s')
  })

  it.each([[null], [0], [-1]])('renders nothing for %s', (value) => {
    expect(formatSpeed(value)).toBe('')
  })
})

describe('formatEta', () => {
  it('avoids a jittery countdown at the low end', () => {
    expect(formatEta(3)).toBe('<10s')
  })

  it('rounds seconds to a coarse step', () => {
    expect(formatEta(37)).toBe('35s')
  })

  it('renders minutes and seconds', () => {
    expect(formatEta(72)).toBe('1m 15s')
  })

  it('drops a zero seconds component', () => {
    expect(formatEta(120)).toBe('2m')
  })

  it('renders hours for long transfers', () => {
    expect(formatEta(3 * 3600 + 25 * 60)).toBe('3h 25m')
  })

  it.each([[null], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]])('renders nothing for %s', (value) => {
    expect(formatEta(value)).toBe('')
  })
})
