import { ref } from 'vue'
import type { ReplaceBookFileResult } from '@bookorbit/types'
import { api } from '@/lib/api'
import { readApiErrorDetail } from '@/lib/api-error'

export function fileExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

export function useReplaceBookFile() {
  const replacing = ref(false)
  const error = ref<string | null>(null)

  async function replaceFile(bookId: number, fileId: number, file: File, fallbackError: string): Promise<ReplaceBookFileResult | null> {
    if (replacing.value) return null
    replacing.value = true
    error.value = null
    try {
      const body = new FormData()
      body.append('file', file, file.name)
      const response = await api(`/api/v1/books/${bookId}/files/${fileId}`, { method: 'PUT', body })
      if (!response.ok) {
        error.value = (await readApiErrorDetail(response)) ?? fallbackError
        return null
      }
      return (await response.json()) as ReplaceBookFileResult
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : fallbackError
      return null
    } finally {
      replacing.value = false
    }
  }

  function resetError() {
    error.value = null
  }

  return { replacing, error, replaceFile, resetError }
}
