import { api } from '@/lib/api'
import type { TagFacetsQuery, TagFacetsResponse } from '@bookorbit/types'

export async function fetchTagFacets(body: TagFacetsQuery, signal?: AbortSignal): Promise<TagFacetsResponse> {
  const res = await api('/api/v1/books/tag-facets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as TagFacetsResponse
}
