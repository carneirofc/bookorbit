import { ChunkUploadErrorCode } from '@bookorbit/types';

import { parseChunkUploadFields } from './upload-chunk.fields';

function field(value: string) {
  return { value };
}

const complete = {
  uploadId: field('abc-123'),
  chunkIndex: field('2'),
  totalChunks: field('5'),
  chunkSize: field('16777216'),
  totalSize: field('80000000'),
  fileName: field('dune.epub'),
};

describe('parseChunkUploadFields', () => {
  it('parses a complete chunk descriptor', () => {
    expect(parseChunkUploadFields(complete)).toEqual({
      uploadId: 'abc-123',
      chunkIndex: 2,
      totalChunks: 5,
      chunkSize: 16_777_216,
      totalSize: 80_000_000,
      fileName: 'dune.epub',
      chunkSha256: undefined,
    });
  });

  it('carries the optional chunk checksum through', () => {
    const parsed = parseChunkUploadFields({ ...complete, chunkSha256: field('a'.repeat(64)) });

    expect(parsed?.chunkSha256).toBe('a'.repeat(64));
  });

  it('takes the first value when a field is repeated', () => {
    expect(parseChunkUploadFields({ ...complete, uploadId: [field('first'), field('second')] })?.uploadId).toBe('first');
  });

  describe('non-chunk requests', () => {
    it.each([
      ['fields are absent', undefined],
      ['fields are null', null],
      ['fields are not an object', 'nope'],
      ['there is no uploadId', { fileName: field('dune.epub') }],
      ['uploadId is not a string', { uploadId: { value: 42 } }],
    ])('returns null when %s', (_label, fields) => {
      expect(parseChunkUploadFields(fields)).toBeNull();
    });
  });

  describe('malformed numbers', () => {
    it.each([
      ['a non-numeric chunkIndex', { chunkIndex: field('abc') }],
      ['a missing totalChunks', { totalChunks: undefined }],
      ['a negative totalSize', { totalSize: field('-1') }],
      ['a fractional chunkSize', { chunkSize: field('1.5') }],
      ['an empty chunkIndex', { chunkIndex: field('') }],
    ])('rejects %s rather than producing NaN', (_label, override) => {
      const err = (() => {
        try {
          parseChunkUploadFields({ ...complete, ...override });
          return null;
        } catch (e: unknown) {
          return e;
        }
      })();

      expect((err as { status?: number })?.status).toBe(400);
      expect((err as { response?: { errorCode?: string } })?.response?.errorCode).toBe(ChunkUploadErrorCode.INVALID_CHUNK_METADATA);
    });
  });
});
