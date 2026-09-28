import { computed, ref, shallowRef, watch } from 'vue'
import {
  DEFAULT_BOOK_EXPORT_PART_SIZE_MB,
  type BookExportPartSizeMb,
  type BookExportScope,
  type BookExportSessionResponse,
  type BookExportSessionStatus,
  type BookSelectionPayload,
} from '@bookorbit/types'
import { api } from '@/lib/api'
import { triggerBrowserDownload } from '@/lib/browserDownload'

const open = ref(false)
const selection = shallowRef<BookSelectionPayload | null>(null)
const scope = ref<BookExportScope>('primary')
const partSizeMb = ref<BookExportPartSizeMb>(DEFAULT_BOOK_EXPORT_PART_SIZE_MB)
const session = ref<BookExportSessionResponse | null>(null)
const startedParts = ref<Set<number>>(new Set())
const preparing = ref(false)
const error = ref<string | null>(null)
const serverActiveParts = ref<Set<number>>(new Set())
const serverActiveExports = ref(0)
// Parts whose download was handed to the browser but that the server has not reported as streaming yet.
const launchingParts = ref<Map<number, number>>(new Map())
let prepareSeq = 0
let statusTimer: ReturnType<typeof setInterval> | null = null

const STATUS_POLL_MS = 2000
const LAUNCH_GRACE_MS = 10_000

async function readErrorMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { message?: unknown }
    return typeof body.message === 'string' ? body.message : null
  } catch {
    return null
  }
}

function partUrl(token: string, index: number): string {
  return `/api/v1/books/export/sessions/${encodeURIComponent(token)}/parts/${index}`
}

function statusUrl(token: string): string {
  return `/api/v1/books/export/sessions/${encodeURIComponent(token)}`
}

function isExpired(value: BookExportSessionResponse): boolean {
  return Date.parse(value.expiresAt) <= Date.now()
}

async function prepare(): Promise<BookExportSessionResponse | null> {
  if (!selection.value) return null
  const seq = ++prepareSeq
  preparing.value = true
  error.value = null
  try {
    const res = await api('/api/v1/books/export/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...selection.value, scope: scope.value, partSizeMb: partSizeMb.value }),
    })
    if (seq !== prepareSeq) return null
    if (!res.ok) {
      session.value = null
      error.value = (await readErrorMessage(res)) ?? ''
      return null
    }
    const next = (await res.json()) as BookExportSessionResponse
    if (seq !== prepareSeq) return null
    session.value = next
    startedParts.value = new Set()
    return next
  } catch {
    if (seq === prepareSeq) error.value = ''
    return null
  } finally {
    if (seq === prepareSeq) preparing.value = false
  }
}

const activeParts = computed(() => new Set([...serverActiveParts.value, ...launchingParts.value.keys()]))

const activeExports = computed(() => {
  let pending = 0
  for (const index of launchingParts.value.keys()) if (!serverActiveParts.value.has(index)) pending++
  return serverActiveExports.value + pending
})

const atCapacity = computed(() => !!session.value && activeExports.value >= session.value.maxConcurrentExports)

async function refreshStatus(): Promise<void> {
  const token = session.value?.token
  if (!token) return
  try {
    const res = await api(statusUrl(token))
    if (!res.ok || session.value?.token !== token) return
    const status = (await res.json()) as BookExportSessionStatus
    if (session.value?.token !== token) return
    serverActiveParts.value = new Set(status.activeParts)
    serverActiveExports.value = status.activeExports
    const now = Date.now()
    const launching = new Map(launchingParts.value)
    for (const [index, launchedAt] of launching) {
      if (serverActiveParts.value.has(index) || now - launchedAt > LAUNCH_GRACE_MS) launching.delete(index)
    }
    launchingParts.value = launching
  } catch {
    // Keep the last known status; the next poll retries.
  }
}

function stopStatusPolling(): void {
  if (statusTimer !== null) clearInterval(statusTimer)
  statusTimer = null
}

watch(
  () => (open.value ? (session.value?.token ?? null) : null),
  (token) => {
    stopStatusPolling()
    serverActiveParts.value = new Set()
    launchingParts.value = new Map()
    if (!token) {
      serverActiveExports.value = 0
      return
    }
    statusTimer = setInterval(() => void refreshStatus(), STATUS_POLL_MS)
  },
  { flush: 'sync' },
)

/**
 * Downloads are native browser downloads (anchor + cookie auth) so multi-GB parts
 * stream straight to disk. An anchor can't report a 404, so an expired session is
 * re-prepared before handing out a part URL.
 */
async function downloadPart(index: number): Promise<void> {
  let current = session.value
  if (!current || atCapacity.value || activeParts.value.has(index)) return
  if (isExpired(current)) {
    current = await prepare()
    if (!current || !current.parts[index]) return
  }
  triggerBrowserDownload(partUrl(current.token, index))
  startedParts.value = new Set(startedParts.value).add(index)
  launchingParts.value = new Map(launchingParts.value).set(index, Date.now())
}

const nextPartIndex = computed(() => session.value?.parts.find((part) => !startedParts.value.has(part.index))?.index ?? null)

async function downloadNextPart(): Promise<void> {
  if (nextPartIndex.value === null) return
  await downloadPart(nextPartIndex.value)
}

/**
 * Prepares a download for the selection. A selection that fits in one part is
 * downloaded right away; anything larger opens the parts dialog.
 */
async function startBulkDownload(target: BookSelectionPayload, initialScope: BookExportScope = 'primary', forceDialog = false): Promise<void> {
  selection.value = target
  scope.value = initialScope
  session.value = null
  startedParts.value = new Set()
  if (forceDialog) open.value = true
  const prepared = await prepare()
  if (selection.value !== target) return
  if (!forceDialog && prepared && prepared.parts.length === 1) {
    await downloadPart(0)
    return
  }
  open.value = true
}

function close(): void {
  prepareSeq++
  open.value = false
  preparing.value = false
  session.value = null
  selection.value = null
  error.value = null
}

export function useBulkDownload() {
  return {
    open,
    scope,
    partSizeMb,
    session,
    startedParts,
    preparing,
    error,
    activeParts,
    atCapacity,
    nextPartIndex,
    prepare,
    downloadPart,
    downloadNextPart,
    startBulkDownload,
    close,
  }
}
