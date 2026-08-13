/**
 * Failure modes of a chunked upload, surfaced as `errorCode` on the error body.
 *
 * Retry policy the client must follow: CHUNK_CORRUPT is the only code that means
 * "re-send this one chunk". Every other code at or above 409 means the session is
 * unusable - restart the whole upload with a fresh uploadId, or give up.
 */
export enum ChunkUploadErrorCode {
  CHUNK_CORRUPT = "chunk_corrupt",
  CHUNK_TOO_LARGE = "chunk_too_large",
  SESSION_MISMATCH = "chunk_session_mismatch",
  SESSION_FINALIZING = "chunk_session_finalizing",
  SESSION_EXPIRED = "chunk_session_expired",
  UPLOAD_TOO_LARGE = "chunk_upload_too_large",
  INVALID_CHUNK_METADATA = "chunk_invalid_metadata",
  ASSEMBLY_FAILED = "chunk_assembly_failed",
  CONTENT_TYPE_MISMATCH = "content_type_mismatch",
  TOO_MANY_UPLOADS = "chunk_too_many_uploads",
  STORAGE_FULL = "chunk_storage_full",
}

/** Hard ceiling on a single chunk request body, enforced at the multipart layer. */
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

/** Chunks below this are pure overhead and would blow up the chunk count. */
export const MIN_CHUNK_BYTES = 256 * 1024;

/**
 * Default chunk size advertised to clients. Small enough that a failed chunk is
 * cheap to re-send and progress moves smoothly, far enough under common reverse
 * proxy body caps (Cloudflare's 100 MB) to survive them.
 */
export const DEFAULT_UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;

/** Refuse absurd chunk counts before allocating a per-chunk bitmap. */
export const MAX_UPLOAD_CHUNKS = 10_000;

/** Header that marks a request as one chunk of a chunked upload. */
export const CHUNK_UPLOAD_HEADER = "x-upload-id";

/** Server response to a chunk that did not complete the upload. */
export type ChunkUploadProgressResponse = {
  chunked: true;
  complete: false;
  receivedChunks: number;
  totalChunks: number;
  finalizing: boolean;
};

export type UploadResult = {
  bookId: number;
  filename: string;
  format: string;
  sizeBytes: number;
};

export type AddBookFileResult = {
  id: number;
  format: string | null;
  role: string;
  sizeBytes: number | null;
  absolutePath: string;
  createdAt: string;
  filename: string;
  durationSeconds: number | null;
  bookStatus: string;
};
