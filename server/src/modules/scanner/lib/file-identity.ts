export interface RecordedFileState {
  sizeBytes: number | null;
  mtime: Date | null;
}

export interface CurrentFileState {
  sizeBytes: number;
  mtime: Date;
}

/**
 * Filesystems hand a deleted file's inode number to the next file created, so an inode match alone
 * can pair a missing book with an unrelated new file. A rename keeps size and mtime, so requiring
 * both to agree is what makes an inode match evidence of the same file.
 */
export function matchesRecordedFileState(recorded: RecordedFileState, current: CurrentFileState): boolean {
  return recorded.sizeBytes === current.sizeBytes && recorded.mtime != null && recorded.mtime.getTime() === current.mtime.getTime();
}
