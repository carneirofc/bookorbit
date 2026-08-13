import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, open, readdir, realpath, stat, unlink, type FileHandle } from 'fs/promises';
import { join } from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';

import { ChunkUploadErrorCode, MAX_CHUNK_BYTES, MAX_UPLOAD_CHUNKS, MIN_CHUNK_BYTES } from '@bookorbit/types';

import { SIGNATURE_HEAD_BYTES } from '../../common/file-signature';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { UploadValidatorService } from './upload-validator.service';

const UPLOAD_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Directory holding in-progress uploads. Dotted so a casual `ls` stays clean. */
export const UPLOADS_DIR = '.uploads';
const PART_SUFFIX = '.part';

const SESSION_TTL_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_SESSIONS_PER_USER = 5;
const MAX_BYTES_RESERVED = 4 * 1024 * 1024 * 1024;
/** Remembering dead ids lets a late chunk get a truthful 410 instead of silently opening a new session. */
const MAX_REMEMBERED_DEAD_SESSIONS = 1_000;

export interface AssembledUpload {
  tempPath: string;
  fileName: string;
  ext: string;
  sizeBytes: number;
  sha256: string;
  /** First `SIGNATURE_HEAD_BYTES` of the assembled file, captured during the hashing pass. */
  head: Buffer;
  uploadId: string;
  startedAt: number;
  /** Removes the temp file. Safe to call after the file has been moved away. */
  release: () => Promise<void>;
}

export type ChunkWriteResult =
  { status: 'partial'; receivedChunks: number; totalChunks: number; finalizing: boolean } | { status: 'assembled'; assembled: AssembledUpload };

export interface WriteChunkParams {
  uploadId: string;
  userId: number;
  rawFileName: string;
  chunkIndex: number;
  totalChunks: number;
  chunkSize: number;
  totalSize: number;
  chunkSha256?: string;
  chunkStream: Readable;
  maxTotalBytes: number;
}

interface ChunkUploadSession {
  uploadId: string;
  userId: number;
  fileName: string;
  ext: string;
  totalChunks: number;
  chunkSize: number;
  totalSize: number;
  tempPath: string;
  received: Uint8Array;
  receivedCount: number;
  bytesWritten: number;
  createdAt: number;
  lastActivityAt: number;
  ready: Promise<void>;
  finalizing: boolean;
}

/** Thrown by the metering transform when a chunk body runs past its declared length. */
class ChunkOverBudgetError extends Error {
  constructor() {
    super('Chunk body exceeds its declared length');
    this.name = 'ChunkOverBudgetError';
  }
}

/**
 * Reassembles chunked uploads on disk.
 *
 * Chunks of one upload arrive concurrently and in any order, so each is written at
 * its own byte offset into a preallocated file and recorded in a per-chunk bitmap.
 * Nothing is inferred from the file's length: because the file is preallocated,
 * its size is correct from the first byte written and says nothing about progress.
 *
 * Sessions are in-memory and therefore do not survive a restart. That is deliberate:
 * a resumable-across-restart protocol needs durable state, and the cost of restarting
 * an interrupted upload is lower than the cost of that machinery. The bootstrap sweep
 * cleans up whatever the previous process left behind.
 */
@Injectable()
export class UploadSessionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(UploadSessionService.name);
  private readonly sessions = new Map<string, ChunkUploadSession>();
  private readonly sessionsPerUser = new Map<number, number>();
  private readonly deadSessions = new Set<string>();
  private bytesReserved = 0;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private uploadDir: string;

  constructor(
    private readonly config: ConfigService,
    private readonly validator: UploadValidatorService,
  ) {
    const appDataPath = this.config.get<string>('storage.appDataPath') ?? '/data';
    this.uploadDir = join(appDataPath, UPLOADS_DIR);
  }

  async onApplicationBootstrap(): Promise<void> {
    await mkdir(this.uploadDir, { recursive: true });
    this.uploadDir = await realpath(this.uploadDir);

    // The registry is empty at boot, so every part file on disk is from a dead process.
    await this.sweepStrayFiles(0);

    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;

    const paths = [...this.sessions.values()].map((session) => session.tempPath);
    this.sessions.clear();
    this.sessionsPerUser.clear();
    this.bytesReserved = 0;
    await Promise.allSettled(paths.map((path) => unlink(path)));
  }

  /** Directory holding in-progress uploads. Callers use it to keep temp files off other filesystems. */
  getUploadDir(): string {
    return this.uploadDir;
  }

  getStats(): { sessions: number; bytesReserved: number } {
    return { sessions: this.sessions.size, bytesReserved: this.bytesReserved };
  }

  async writeChunk(params: WriteChunkParams): Promise<ChunkWriteResult> {
    const session = this.resolveSession(params);
    session.lastActivityAt = Date.now();

    try {
      await session.ready;
    } catch (err) {
      this.destroySession(session, true);
      throw this.toStorageError(err, session, params.chunkIndex);
    }

    const offset = params.chunkIndex * session.chunkSize;
    const expectedLen = this.expectedChunkLength(session, params.chunkIndex);
    const written = await this.writeAt(session, params, offset, expectedLen);

    // No await from here to the end of the block: the synchronous run is what makes
    // the completion claim exclusive when the last chunks resolve back to back.
    if (session.received[params.chunkIndex] === 1) return this.partial(session);
    session.received[params.chunkIndex] = 1;
    session.receivedCount += 1;
    session.bytesWritten += written;
    if (session.receivedCount < session.totalChunks || session.finalizing) return this.partial(session);
    session.finalizing = true;

    try {
      return { status: 'assembled', assembled: await this.finalize(session) };
    } catch (err) {
      // The assembled bytes are proven bad, so `finalizing` deliberately stays set:
      // there is nothing a further chunk could do to rescue this session.
      this.destroySession(session, true);
      await unlink(session.tempPath).catch(() => undefined);
      this.logSessionFailure(session, err);
      throw err;
    }
  }

  async abort(uploadId: string, userId: number): Promise<void> {
    const session = this.sessions.get(sessionKey(userId, uploadId));
    if (!session) return;

    this.destroySession(session, true);
    await unlink(session.tempPath).catch(() => undefined);
    this.logger.log(
      `[upload.chunk_session] [end] uploadId="${sanitizeLogValue(uploadId)}" userId=${userId} receivedChunks=${session.receivedCount}/${session.totalChunks} durationMs=${Date.now() - session.createdAt} outcome=aborted - chunked upload aborted by client`,
    );
  }

  private resolveSession(params: WriteChunkParams): ChunkUploadSession {
    const key = sessionKey(params.userId, params.uploadId);
    const existing = this.sessions.get(key);
    if (existing) {
      this.assertMatchesSession(existing, params);
      if (existing.finalizing) {
        throw new ConflictException({
          message: 'This upload is already being assembled',
          errorCode: ChunkUploadErrorCode.SESSION_FINALIZING,
        });
      }
      return existing;
    }

    // Without this a chunk for a swept session would quietly open a fresh one and the
    // upload could never complete, since the chunks written before the sweep are gone.
    if (this.deadSessions.has(key)) throw unknownSession();

    return this.openSession(key, params);
  }

  private markDead(session: ChunkUploadSession): void {
    if (this.deadSessions.size >= MAX_REMEMBERED_DEAD_SESSIONS) {
      const oldest = this.deadSessions.values().next();
      if (!oldest.done) this.deadSessions.delete(oldest.value);
    }
    this.deadSessions.add(sessionKey(session.userId, session.uploadId));
  }

  /**
   * Validates and registers a session without yielding, so two concurrent chunks of a
   * brand-new upload cannot each create one. The file itself is created asynchronously
   * and every caller awaits the same `ready` promise.
   */
  private openSession(key: string, params: WriteChunkParams): ChunkUploadSession {
    const { uploadId, userId, rawFileName, chunkIndex, totalChunks, chunkSize, totalSize, maxTotalBytes } = params;

    if (!UPLOAD_ID_PATTERN.test(uploadId)) throw invalidMetadata('Invalid upload id');
    if (!isPositiveInt(totalChunks) || totalChunks > MAX_UPLOAD_CHUNKS) throw invalidMetadata('Invalid chunk count');
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) throw invalidMetadata('Invalid chunk index');
    if (!isPositiveInt(chunkSize) || chunkSize < MIN_CHUNK_BYTES || chunkSize > MAX_CHUNK_BYTES) throw invalidMetadata('Invalid chunk size');
    if (!isPositiveInt(totalSize)) throw invalidMetadata('Invalid total size');

    // Before the arithmetic check, so an oversized file is told it is oversized rather
    // than being told its chunk count is wrong.
    if (totalSize > maxTotalBytes) {
      throw new PayloadTooLargeException({
        message: `File exceeds the ${Math.floor(maxTotalBytes / (1024 * 1024))} MB upload limit`,
        errorCode: ChunkUploadErrorCode.UPLOAD_TOO_LARGE,
      });
    }

    if (Math.ceil(totalSize / chunkSize) !== totalChunks) throw invalidMetadata('Chunk count does not match the declared file size');

    // Format is checked here rather than at assembly so an unsupported file never
    // reaches the filesystem at all.
    const fileName = this.validator.sanitizeFilename(rawFileName);
    const ext = this.validator.validateBookFormat(fileName);

    if ((this.sessionsPerUser.get(userId) ?? 0) >= MAX_SESSIONS_PER_USER) {
      throw tooManyUploads('Too many uploads in progress');
    }
    if (this.bytesReserved + totalSize > MAX_BYTES_RESERVED) {
      throw tooManyUploads('The server is already assembling too much upload data');
    }

    const now = Date.now();
    const session: ChunkUploadSession = {
      uploadId,
      userId,
      fileName,
      ext,
      totalChunks,
      chunkSize,
      totalSize,
      tempPath: join(this.uploadDir, `${randomUUID()}${PART_SUFFIX}`),
      received: new Uint8Array(totalChunks),
      receivedCount: 0,
      bytesWritten: 0,
      createdAt: now,
      lastActivityAt: now,
      ready: Promise.resolve(),
      finalizing: false,
    };

    session.ready = this.prepareFile(session);
    this.sessions.set(key, session);
    this.sessionsPerUser.set(userId, (this.sessionsPerUser.get(userId) ?? 0) + 1);
    this.bytesReserved += totalSize;

    this.logger.log(
      `[upload.chunk_session] [start] uploadId="${sanitizeLogValue(uploadId)}" userId=${userId} fileName="${sanitizeLogValue(fileName)}" ext=${ext} totalChunks=${totalChunks} chunkSize=${chunkSize} totalSize=${totalSize} - chunked upload session opened`,
    );

    return session;
  }

  /**
   * `truncate` makes the file sparse, which costs nothing and is not a reservation -
   * a later write can still fail with ENOSPC.
   */
  private async prepareFile(session: ChunkUploadSession): Promise<void> {
    const fh = await open(session.tempPath, 'wx');
    try {
      await fh.truncate(session.totalSize);
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  private assertMatchesSession(session: ChunkUploadSession, params: WriteChunkParams): void {
    if (!Number.isInteger(params.chunkIndex) || params.chunkIndex < 0 || params.chunkIndex >= session.totalChunks) {
      throw invalidMetadata('Invalid chunk index');
    }

    const sameShape =
      session.totalChunks === params.totalChunks &&
      session.chunkSize === params.chunkSize &&
      session.totalSize === params.totalSize &&
      session.fileName === this.validator.sanitizeFilename(params.rawFileName);

    if (!sameShape) {
      throw new ConflictException({
        message: 'This upload id is already in use for a different file',
        errorCode: ChunkUploadErrorCode.SESSION_MISMATCH,
      });
    }
  }

  private expectedChunkLength(session: ChunkUploadSession, chunkIndex: number): number {
    const offset = chunkIndex * session.chunkSize;
    return Math.min(session.chunkSize, session.totalSize - offset);
  }

  /**
   * Streams one chunk to its offset, hashing and counting as it passes.
   *
   * `open(path, 'r+')` plus `createWriteStream({ start })` is the only correct pairing
   * here: flag `'w'` would truncate the whole file and destroy every sibling chunk,
   * and flag `'a'` ignores `start` outright because O_APPEND forces writes to the end.
   * Each request gets its own handle - a handle shared across concurrent streams would
   * hand them a shared file position.
   */
  private async writeAt(session: ChunkUploadSession, params: WriteChunkParams, offset: number, expectedLen: number): Promise<number> {
    if (params.chunkSha256 !== undefined && !SHA256_PATTERN.test(params.chunkSha256)) {
      throw invalidMetadata('Invalid chunk checksum');
    }

    const hash = createHash('sha256');
    let written = 0;

    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        if (written > expectedLen) {
          callback(new ChunkOverBudgetError());
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    let fh: FileHandle;
    try {
      fh = await open(session.tempPath, 'r+');
    } catch (err) {
      this.destroySession(session, true);
      throw this.toStorageError(err, session, params.chunkIndex);
    }

    try {
      await pipeline(params.chunkStream, meter, fh.createWriteStream({ start: offset }));
    } catch (err) {
      if (err instanceof ChunkOverBudgetError) {
        // The session survives: the bit stays unset, so these stray bytes can never
        // be part of a completed upload, and a correct retry overwrites them.
        this.logChunkFailure(session, params.chunkIndex, 'over_budget', expectedLen, written);
        throw new PayloadTooLargeException({
          message: 'Chunk is larger than declared',
          errorCode: ChunkUploadErrorCode.CHUNK_TOO_LARGE,
        });
      }
      this.destroySession(session, true);
      await unlink(session.tempPath).catch(() => undefined);
      throw this.toStorageError(err, session, params.chunkIndex);
    } finally {
      await fh.close().catch(() => undefined);
    }

    const truncated = (params.chunkStream as Readable & { truncated?: boolean }).truncated === true;
    if (truncated) throw this.corruptChunk(session, params.chunkIndex, 'truncated', expectedLen, written);
    if (written !== expectedLen) throw this.corruptChunk(session, params.chunkIndex, 'short_write', expectedLen, written);

    if (params.chunkSha256 !== undefined && hash.digest('hex') !== params.chunkSha256) {
      throw this.corruptChunk(session, params.chunkIndex, 'hash_mismatch', expectedLen, written);
    }

    return written;
  }

  /** One sequential pass over the assembled file: content hash and signature head together. */
  private async finalize(session: ChunkUploadSession): Promise<AssembledUpload> {
    const hash = createHash('sha256');
    const headChunks: Buffer[] = [];
    let headBytes = 0;
    let sizeBytes = 0;

    for await (const chunk of createReadStream(session.tempPath) as AsyncIterable<Buffer>) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      if (headBytes < SIGNATURE_HEAD_BYTES) {
        const slice = chunk.subarray(0, SIGNATURE_HEAD_BYTES - headBytes);
        headChunks.push(Buffer.from(slice));
        headBytes += slice.length;
      }
    }

    if (sizeBytes !== session.totalSize || session.bytesWritten !== session.totalSize) {
      throw new UnprocessableEntityException({
        message: 'Assembled file does not match the declared size',
        errorCode: ChunkUploadErrorCode.ASSEMBLY_FAILED,
      });
    }

    this.destroySession(session, false);

    return {
      tempPath: session.tempPath,
      fileName: session.fileName,
      ext: session.ext,
      sizeBytes,
      sha256: hash.digest('hex'),
      head: Buffer.concat(headChunks),
      uploadId: session.uploadId,
      startedAt: session.createdAt,
      release: () => unlink(session.tempPath).catch(() => undefined),
    };
  }

  private partial(session: ChunkUploadSession): ChunkWriteResult {
    return {
      status: 'partial',
      receivedChunks: session.receivedCount,
      totalChunks: session.totalChunks,
      finalizing: session.finalizing,
    };
  }

  /**
   * Drops the session from the registry and releases its quota. Does not touch the file.
   *
   * `dead` marks the id as unusable so later chunks are refused rather than starting a
   * new session; the successful-assembly path passes false, since nothing went wrong.
   */
  private destroySession(session: ChunkUploadSession, dead: boolean): void {
    const key = sessionKey(session.userId, session.uploadId);
    if (!this.sessions.delete(key)) return;

    if (dead) this.markDead(session);
    this.bytesReserved -= session.totalSize;
    const remaining = (this.sessionsPerUser.get(session.userId) ?? 1) - 1;
    if (remaining > 0) this.sessionsPerUser.set(session.userId, remaining);
    else this.sessionsPerUser.delete(session.userId);
  }

  private corruptChunk(session: ChunkUploadSession, chunkIndex: number, reason: string, expectedBytes: number, writtenBytes: number): HttpException {
    this.logChunkFailure(session, chunkIndex, reason, expectedBytes, writtenBytes);
    return new UnprocessableEntityException({
      message: 'Chunk failed its integrity check',
      errorCode: ChunkUploadErrorCode.CHUNK_CORRUPT,
    });
  }

  private toStorageError(err: unknown, session: ChunkUploadSession, chunkIndex: number): HttpException {
    if (err instanceof HttpException) return err;

    const code = (err as NodeJS.ErrnoException).code;
    this.logChunkFailure(session, chunkIndex, code === 'ENOSPC' ? 'disk_full' : 'write_error');

    return new HttpException(
      { message: 'Could not store the upload', errorCode: ChunkUploadErrorCode.STORAGE_FULL },
      HttpStatus.INSUFFICIENT_STORAGE,
    );
  }

  private logChunkFailure(session: ChunkUploadSession, chunkIndex: number, reason: string, expectedBytes?: number, writtenBytes?: number): void {
    const bytes = expectedBytes === undefined ? '' : ` expectedBytes=${expectedBytes} writtenBytes=${writtenBytes}`;
    this.logger.warn(
      `[upload.chunk_write] [fail] uploadId="${sanitizeLogValue(session.uploadId)}" userId=${session.userId} chunkIndex=${chunkIndex} reason=${reason}${bytes} - chunk rejected`,
    );
  }

  private logSessionFailure(session: ChunkUploadSession, err: unknown): void {
    const errorClass = err instanceof Error ? err.name : 'Error';
    const message = sanitizeLogValue(err instanceof Error ? err.message : String(err));
    this.logger.warn(
      `[upload.chunk_session] [fail] uploadId="${sanitizeLogValue(session.uploadId)}" userId=${session.userId} reason=assembly receivedChunks=${session.receivedCount}/${session.totalChunks} durationMs=${Date.now() - session.createdAt} errorClass=${errorClass} error="${message}" - chunked upload session failed`,
    );
  }

  private async sweep(): Promise<void> {
    const cutoff = Date.now() - SESSION_TTL_MS;
    let expiredSessions = 0;
    let reclaimedBytes = 0;

    for (const session of [...this.sessions.values()]) {
      if (session.lastActivityAt > cutoff || session.finalizing) continue;
      expiredSessions += 1;
      reclaimedBytes += session.bytesWritten;
      this.destroySession(session, true);
      await unlink(session.tempPath).catch(() => undefined);
    }

    const strayFiles = await this.sweepStrayFiles(SESSION_TTL_MS);

    if (expiredSessions === 0 && strayFiles === 0) return;
    this.logger.log(
      `[upload.chunk_sweep] [end] expiredSessions=${expiredSessions} strayFiles=${strayFiles} reclaimedBytes=${reclaimedBytes} - abandoned upload sweep complete`,
    );
  }

  /**
   * Removes part files that no live session owns. `minAgeMs` of 0 means unconditional,
   * which is what the bootstrap sweep wants: comparing against a cutoff of "now" would
   * spare a file whose mtime happens to round past it.
   */
  private async sweepStrayFiles(minAgeMs: number): Promise<number> {
    const owned = new Set([...this.sessions.values()].map((session) => session.tempPath));
    const cutoff = Date.now() - minAgeMs;
    let removed = 0;

    let entries: string[];
    try {
      entries = await readdir(this.uploadDir);
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'Error';
      const message = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(`[upload.chunk_sweep] [fail] errorClass=${errorClass} error="${message}" - abandoned upload sweep failed`);
      return 0;
    }

    for (const entry of entries) {
      if (!entry.endsWith(PART_SUFFIX)) continue;
      const path = join(this.uploadDir, entry);
      if (owned.has(path)) continue;

      try {
        const { mtimeMs } = await stat(path);
        if (minAgeMs > 0 && mtimeMs > cutoff) continue;
        await unlink(path);
        removed += 1;
      } catch {
        // Raced with another sweep or with a finalize; nothing to do.
      }
    }

    return removed;
  }
}

function sessionKey(userId: number, uploadId: string): string {
  return `${userId}:${uploadId}`;
}

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function invalidMetadata(message: string): HttpException {
  return new BadRequestException({ message, errorCode: ChunkUploadErrorCode.INVALID_CHUNK_METADATA });
}

function tooManyUploads(message: string): HttpException {
  return new HttpException({ message, errorCode: ChunkUploadErrorCode.TOO_MANY_UPLOADS }, HttpStatus.TOO_MANY_REQUESTS);
}

/**
 * An unknown or expired upload id is reported the same way as one belonging to another
 * user, so ids cannot be probed to learn about other people's uploads. Sessions are keyed
 * by user, so the wrong-user case simply misses the map and needs no special branch.
 */
function unknownSession(): HttpException {
  return new GoneException({
    message: 'This upload session is no longer available',
    errorCode: ChunkUploadErrorCode.SESSION_EXPIRED,
  });
}
