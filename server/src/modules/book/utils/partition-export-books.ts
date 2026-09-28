export type ExportBookSize = { bookId: number; bytes: number; fileCount: number };

export type ExportPartPlan = { bookIds: number[]; bytes: number; fileCount: number; oversized: boolean };

/**
 * Greedily packs books into parts in selection order without splitting a book.
 * A book that alone exceeds a limit gets its own part and is flagged oversized.
 */
export function partitionBooksBySize(entries: Iterable<ExportBookSize>, maxBytes: number, maxFiles: number): ExportPartPlan[] {
  const parts: ExportPartPlan[] = [];
  let current: ExportPartPlan | null = null;

  for (const entry of entries) {
    const fitsCurrent = current !== null && current.bytes + entry.bytes <= maxBytes && current.fileCount + entry.fileCount <= maxFiles;
    if (!fitsCurrent) {
      current = { bookIds: [], bytes: 0, fileCount: 0, oversized: false };
      parts.push(current);
    }
    const part = current as ExportPartPlan;
    part.bookIds.push(entry.bookId);
    part.bytes += entry.bytes;
    part.fileCount += entry.fileCount;
    if (part.bytes > maxBytes || part.fileCount > maxFiles) part.oversized = true;
  }

  return parts;
}
