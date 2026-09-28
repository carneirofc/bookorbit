import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { triggerBrowserDownload } from '@/lib/browserDownload'

type ExportScope = 'primary' | 'all' | 'audio'

export function useBookDownload() {
  const isDownloading = ref(false)

  async function downloadFile(fileId: number): Promise<void> {
    isDownloading.value = true
    try {
      triggerBrowserDownload(`/api/v1/books/files/${fileId}/download`)
    } catch {
      toast.error('Download failed')
    } finally {
      isDownloading.value = false
    }
  }

  async function exportBooks(bookIds: number[], allFormats: boolean, scopeOverride?: ExportScope): Promise<void> {
    if (bookIds.length === 0) return
    const label = `${bookIds.length} book${bookIds.length === 1 ? '' : 's'}`
    const toastId = toast.loading(`Preparing ${label} for download...`)
    isDownloading.value = true
    try {
      const scope = scopeOverride ?? (allFormats ? 'all' : 'primary')
      const params = new URLSearchParams({
        bookIds: bookIds.join(','),
        scope,
      })
      toast.dismiss(toastId)
      triggerBrowserDownload(`/api/v1/books/export/download?${params.toString()}`)
    } catch {
      toast.dismiss(toastId)
      toast.error('Export failed')
    } finally {
      isDownloading.value = false
    }
  }

  return { isDownloading, downloadFile, exportBooks }
}
