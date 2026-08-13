const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** Compact size for a progress row: "512 KB", "1.4 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'

  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1)
  const value = bytes / 1024 ** exponent
  const decimals = exponent === 0 || value >= 100 ? 0 : 1

  return `${value.toFixed(decimals)} ${BYTE_UNITS[exponent]}`
}

export function formatSpeed(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || bytesPerSecond <= 0) return ''
  return `${formatBytes(bytesPerSecond)}/s`
}

/** Coarse by design: a countdown that jitters between "1m 3s" and "58s" reads as broken. */
export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 10) return '<10s'
  if (seconds < 60) return `${Math.round(seconds / 5) * 5}s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${Math.round((seconds % 60) / 15) * 15}s`.replace(' 60s', 'm').replace(' 0s', '')

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
