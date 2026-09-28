import type { BookSelectionPayload } from "./book-selection";

export type BookExportScope = "primary" | "all" | "audio";

export const BOOK_EXPORT_PART_SIZES_MB = [500, 1024, 2048] as const;
export type BookExportPartSizeMb = (typeof BOOK_EXPORT_PART_SIZES_MB)[number];
export const DEFAULT_BOOK_EXPORT_PART_SIZE_MB: BookExportPartSizeMb = 1024;

export type CreateBookExportSessionRequest = BookSelectionPayload & {
  scope: BookExportScope;
  partSizeMb?: BookExportPartSizeMb;
};

export type BookExportPart = {
  index: number;
  bookCount: number;
  fileCount: number;
  bytes: number;
  oversized: boolean;
};

export type BookExportSessionResponse = {
  token: string;
  scope: BookExportScope;
  expiresAt: string;
  bookCount: number;
  skippedBookCount: number;
  totalBytes: number;
  parts: BookExportPart[];
  maxConcurrentExports: number;
};

export type BookExportSessionStatus = {
  activeParts: number[];
  activeExports: number;
};
