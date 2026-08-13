import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';

import { ChunkUploadErrorCode } from '@bookorbit/types';

import { UploadValidatorService } from './upload-validator.service';
import { UploadSessionService, UPLOADS_DIR, type ChunkWriteResult } from './upload-session.service';

const CHUNK_SIZE = 256 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

function errorCodeOf(err: unknown): string | undefined {
  const response = (err as { response?: { errorCode?: string } }).response;
  return response?.errorCode;
}

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number }).status;
}

describe('UploadSessionService', () => {
  let root: string;
  let uploadDir: string;
  let service: UploadSessionService;
  let source: Buffer;
  let totalChunks: number;

  function makeConfig(): ConfigService {
    return { get: vi.fn().mockImplementation((key: string) => (key === 'storage.appDataPath' ? root : undefined)) } as unknown as ConfigService;
  }

  function chunkOf(index: number): Buffer {
    return source.subarray(index * CHUNK_SIZE, Math.min((index + 1) * CHUNK_SIZE, source.length));
  }

  function write(index: number, overrides: Partial<Parameters<UploadSessionService['writeChunk']>[0]> = {}) {
    const body = overrides.chunkStream ? undefined : chunkOf(index);
    return service.writeChunk({
      uploadId: 'upload-1',
      userId: 7,
      rawFileName: 'dune.epub',
      chunkIndex: index,
      totalChunks,
      chunkSize: CHUNK_SIZE,
      totalSize: source.length,
      chunkStream: body ? Readable.from([body]) : Readable.from([]),
      maxTotalBytes: MAX_TOTAL_BYTES,
      ...overrides,
    });
  }

  function assembledOf(results: ChunkWriteResult[]) {
    return results.filter((r) => r.status === 'assembled');
  }

  /**
   * Rebuilds `service` under fake timers. The sweep interval is created during bootstrap,
   * so installing fake timers afterwards would leave the real interval in place and
   * `advanceTimersByTime` would never fire it.
   */
  async function withSweeperClock(body: () => Promise<void>): Promise<void> {
    await service.onModuleDestroy();
    vi.useFakeTimers();
    try {
      service = new UploadSessionService(makeConfig(), new UploadValidatorService());
      await service.onApplicationBootstrap();
      await body();
    } finally {
      vi.useRealTimers();
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bookorbit-upload-session-test-'));
    uploadDir = join(root, UPLOADS_DIR);
    service = new UploadSessionService(makeConfig(), new UploadValidatorService());
    await service.onApplicationBootstrap();

    // A ZIP signature keeps the assembled bytes plausible as the .epub they claim to be.
    source = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(CHUNK_SIZE * 2 + 1234)]);
    totalChunks = Math.ceil(source.length / CHUNK_SIZE);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    await rm(root, { recursive: true, force: true });
  });

  describe('assembly', () => {
    it('reassembles chunks that arrive out of order', async () => {
      expect(totalChunks).toBe(3);
      await write(2);
      await write(0);
      const result = await write(1);

      expect(result.status).toBe('assembled');
      if (result.status !== 'assembled') return;
      expect(await readFile(result.assembled.tempPath)).toEqual(source);
      expect(result.assembled.sizeBytes).toBe(source.length);
      expect(result.assembled.sha256).toBe(createHash('sha256').update(source).digest('hex'));
      expect(result.assembled.fileName).toBe('dune.epub');
      expect(result.assembled.ext).toBe('epub');
    });

    it('captures a signature head that identifies the assembled file', async () => {
      await write(0);
      await write(1);
      const result = await write(2);

      if (result.status !== 'assembled') throw new Error('expected assembly');
      expect(result.assembled.head.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    });

    it('produces exactly one assembly when every chunk lands concurrently', async () => {
      const results = await Promise.all(Array.from({ length: totalChunks }, (_, i) => write(i)));

      expect(assembledOf(results)).toHaveLength(1);
      expect(results.filter((r) => r.status === 'partial')).toHaveLength(totalChunks - 1);
    });

    it('reports progress on each incomplete chunk', async () => {
      const first = await write(0);

      expect(first).toMatchObject({ status: 'partial', receivedChunks: 1, totalChunks: 3, finalizing: false });
    });

    it('treats a duplicate chunk as idempotent rather than progress', async () => {
      await write(0);
      await write(0);
      const third = await write(0);

      expect(third).toMatchObject({ status: 'partial', receivedChunks: 1 });
    });

    it('releases the temp file on request', async () => {
      const results = await Promise.all(Array.from({ length: totalChunks }, (_, i) => write(i)));
      const [assembled] = assembledOf(results);
      if (assembled.status !== 'assembled') throw new Error('expected assembly');

      await assembled.assembled.release();

      expect(await readdir(uploadDir)).toHaveLength(0);
    });

    it('clears the session once assembled, so its quota is returned', async () => {
      await Promise.all(Array.from({ length: totalChunks }, (_, i) => write(i)));

      expect(service.getStats()).toEqual({ sessions: 0, bytesReserved: 0 });
    });
  });

  describe('integrity', () => {
    it('accepts a chunk whose checksum matches', async () => {
      const result = await write(0, { chunkSha256: createHash('sha256').update(chunkOf(0)).digest('hex') });

      expect(result.status).toBe('partial');
    });

    it('rejects a chunk whose checksum does not match', async () => {
      const err = await write(0, { chunkSha256: 'a'.repeat(64) }).catch((e: unknown) => e);

      expect(statusOf(err)).toBe(422);
      expect(errorCodeOf(err)).toBe(ChunkUploadErrorCode.CHUNK_CORRUPT);
    });

    it('rejects a malformed checksum before writing', async () => {
      const err = await write(0, { chunkSha256: 'not-a-hash' }).catch((e: unknown) => e);

      expect(errorCodeOf(err)).toBe(ChunkUploadErrorCode.INVALID_CHUNK_METADATA);
    });

    it('lets a corrupt chunk be retried, overwriting the bad bytes', async () => {
      const corrupt = Buffer.alloc(CHUNK_SIZE, 0xff);
      await write(1, { chunkStream: Readable.from([corrupt]), chunkSha256: 'b'.repeat(64) }).catch(() => undefined);

      await write(0);
      await write(1);
      const result = await write(2);

      if (result.status !== 'assembled') throw new Error('expected assembly');
      expect(await readFile(result.assembled.tempPath)).toEqual(source);
    });

    it('rejects a chunk shorter than its declared length', async () => {
      const err = await write(0, { chunkStream: Readable.from([chunkOf(0).subarray(0, 10)]) }).catch((e: unknown) => e);

      expect(errorCodeOf(err)).toBe(ChunkUploadErrorCode.CHUNK_CORRUPT);
    });

    it('rejects a chunk the multipart layer truncated', async () => {
      const stream = Object.assign(Readable.from([chunkOf(0)]), { truncated: true });
      const err = await write(0, { chunkStream: stream }).catch((e: unknown) => e);

      expect(errorCodeOf(err)).toBe(ChunkUploadErrorCode.CHUNK_CORRUPT);
    });

    it('does not count a rejected chunk as received', async () => {
      await write(0, { chunkStream: Readable.from([chunkOf(0).subarray(0, 10)]) }).catch(() => undefined);
      const result = await write(1);

      expect(result).toMatchObject({ status: 'partial', receivedChunks: 1 });
    });

    it('rejects a chunk longer than its declared length without letting it complete', async () => {
      const err = await write(0, { chunkStream: Readable.from([Buffer.alloc(CHUNK_SIZE * 2)]) }).catch((e: unknown) => e);

      expect(statusOf(err)).toBe(413);
      expect(errorCodeOf(err)).toBe(ChunkUploadErrorCode.CHUNK_TOO_LARGE);
    });
  });

  describe('validation before any bytes are written', () => {
    it('refuses a file larger than the limit and creates nothing', async () => {
      const oversized = MAX_TOTAL_BYTES + 1;
      const err = await write(0, {
        totalSize: oversized,
        totalChunks: Math.ceil(oversized / CHUNK_SIZE),
        maxTotalBytes: MAX_TOTAL_BYTES,
      }).catch((e: unknown) => e);

      expect(statusOf(err)).toBe(413);
      expect(errorCodeOf(err)).toBe(ChunkUploadErrorCode.UPLOAD_TOO_LARGE);
      expect(await readdir(uploadDir)).toHaveLength(0);
    });

    it('refuses an unsupported extension and creates nothing', async () => {
      const err = await write(0, { rawFileName: 'notes.txt' }).catch((e: unknown) => e);

      expect(statusOf(err)).toBe(400);
      expect(await readdir(uploadDir)).toHaveLength(0);
    });

    it.each([
      ['an upload id with illegal characters', { uploadId: '../escape' }],
      ['a chunk count of zero', { totalChunks: 0 }],
      ['a chunk index past the end', { chunkIndex: 99 }],
      ['a chunk size below the floor', { chunkSize: 1024 }],
      ['arithmetic that does not add up', { totalChunks: 99 }],
    ])('refuses %s', async (_label, overrides) => {
      const err = await write(0, overrides as never).catch((e: unknown) => e);

      expect(errorCodeOf(err)).toBe(ChunkUploadErrorCode.INVALID_CHUNK_METADATA);
      expect(await readdir(uploadDir)).toHaveLength(0);
    });
  });

  describe('session identity', () => {
    it('refuses a second file reusing a live upload id', async () => {
      await write(0);
      const err = await write(1, { rawFileName: 'other.epub' }).catch((e: unknown) => e);

      expect(statusOf(err)).toBe(409);
      expect(errorCodeOf(err)).toBe(ChunkUploadErrorCode.SESSION_MISMATCH);
      expect(service.getStats().sessions).toBe(1);
    });

    it('refuses a chunk whose declared size contradicts the session', async () => {
      await write(0);
      const err = await write(1, { totalSize: source.length + CHUNK_SIZE, totalChunks: totalChunks + 1 }).catch((e: unknown) => e);

      expect(errorCodeOf(err)).toBe(ChunkUploadErrorCode.SESSION_MISMATCH);
    });

    it('keeps two users with the same upload id fully separate', async () => {
      await write(0);
      const other = await write(0, { userId: 8, rawFileName: 'different.epub', totalSize: CHUNK_SIZE, totalChunks: 1 });

      expect(other.status).toBe('assembled');
      expect(service.getStats().sessions).toBe(1);
    });

    it('reports an abandoned session as expired rather than reopening it', async () => {
      await write(0, { userId: 8 });
      await service.abort('upload-1', 8);

      const err = await write(1, { userId: 8 }).catch((e: unknown) => e);

      expect(statusOf(err)).toBe(410);
      expect(errorCodeOf(err)).toBe(ChunkUploadErrorCode.SESSION_EXPIRED);
    });
  });

  describe('quotas', () => {
    it('refuses more than the per-user session cap', async () => {
      for (let i = 0; i < 5; i++) {
        await write(0, { uploadId: `upload-cap-${i}` });
      }

      const err = await write(0, { uploadId: 'upload-cap-5' }).catch((e: unknown) => e);

      expect(statusOf(err)).toBe(429);
      expect(errorCodeOf(err)).toBe(ChunkUploadErrorCode.TOO_MANY_UPLOADS);
    });

    it('frees a slot when a session is aborted', async () => {
      for (let i = 0; i < 5; i++) {
        await write(0, { uploadId: `upload-cap-${i}` });
      }
      await service.abort('upload-cap-0', 7);

      await expect(write(0, { uploadId: 'upload-cap-5' })).resolves.toMatchObject({ status: 'partial' });
    });

    it('reserves the declared size, not the bytes received so far', async () => {
      await write(0);

      expect(service.getStats()).toEqual({ sessions: 1, bytesReserved: source.length });
    });
  });

  describe('cleanup', () => {
    it('removes the temp file when a session is aborted', async () => {
      await write(0);
      expect(await readdir(uploadDir)).toHaveLength(1);

      await service.abort('upload-1', 7);

      expect(await readdir(uploadDir)).toHaveLength(0);
      expect(service.getStats()).toEqual({ sessions: 0, bytesReserved: 0 });
    });

    it('sweeps sessions that have gone quiet past the TTL', async () => {
      await withSweeperClock(async () => {
        await write(0);
        expect(await readdir(uploadDir)).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(31 * 60_000);

        expect(service.getStats().sessions).toBe(0);
        expect(await readdir(uploadDir)).toHaveLength(0);
      });
    });

    it('leaves an active session alone while it is still being written to', async () => {
      await withSweeperClock(async () => {
        await write(0);
        await vi.advanceTimersByTimeAsync(20 * 60_000);
        await write(1);
        await vi.advanceTimersByTimeAsync(20 * 60_000);

        expect(service.getStats().sessions).toBe(1);
      });
    });

    it('refuses a chunk for a session that was already swept', async () => {
      let err: unknown;
      await withSweeperClock(async () => {
        await write(0);
        await vi.advanceTimersByTimeAsync(31 * 60_000);
        err = await write(1).catch((e: unknown) => e);
      });

      expect(statusOf(err)).toBe(410);
      expect(errorCodeOf(err)).toBe(ChunkUploadErrorCode.SESSION_EXPIRED);
    });

    it('clears part files left behind by a previous process on bootstrap', async () => {
      await writeFile(join(uploadDir, 'left-over.part'), 'stale');
      await writeFile(join(uploadDir, 'unrelated.txt'), 'keep');

      const restarted = new UploadSessionService(makeConfig(), new UploadValidatorService());
      await restarted.onApplicationBootstrap();
      await restarted.onModuleDestroy();

      expect(await readdir(uploadDir)).toEqual(['unrelated.txt']);
    });

    it('stops sweeping and drops live temp files on shutdown', async () => {
      await write(0);

      await service.onModuleDestroy();

      expect(await readdir(uploadDir)).toHaveLength(0);
      expect(service.getStats()).toEqual({ sessions: 0, bytesReserved: 0 });
    });
  });
});
