import { BadRequestException } from '@nestjs/common';

import { ChunkUploadErrorCode } from '@bookorbit/types';

export interface ChunkUploadFields {
  uploadId: string;
  chunkIndex: number;
  totalChunks: number;
  chunkSize: number;
  totalSize: number;
  fileName?: string;
  chunkSha256?: string;
}

/** Multipart fields arrive as objects, or as arrays of them when a name repeats. */
function readField(field: unknown): string | undefined {
  const candidate = Array.isArray(field) ? field[0] : field;
  const value = (candidate as { value?: unknown } | undefined)?.value;
  return typeof value === 'string' ? value : undefined;
}

/** Rejects anything `Number()` would quietly turn into NaN or a float. */
function readIntField(fields: Record<string, unknown>, name: string): number {
  const raw = readField(fields[name]);
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new BadRequestException({
      message: `Missing or malformed ${name}`,
      errorCode: ChunkUploadErrorCode.INVALID_CHUNK_METADATA,
    });
  }
  return Number(raw);
}

/**
 * Extracts the chunk descriptor from a multipart upload, or null when the request is a
 * plain whole-file upload.
 *
 * `fields` is absent entirely for a single-file upload carrying no extra form fields.
 */
export function parseChunkUploadFields(fields: unknown): ChunkUploadFields | null {
  if (!fields || typeof fields !== 'object') return null;

  const record = fields as Record<string, unknown>;
  const uploadId = readField(record.uploadId);
  if (!uploadId) return null;

  return {
    uploadId,
    chunkIndex: readIntField(record, 'chunkIndex'),
    totalChunks: readIntField(record, 'totalChunks'),
    chunkSize: readIntField(record, 'chunkSize'),
    totalSize: readIntField(record, 'totalSize'),
    fileName: readField(record.fileName),
    chunkSha256: readField(record.chunkSha256),
  };
}
