import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { rename, stat } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { ReplaceBookFileResult } from '@bookorbit/types';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { bookFileChapters, bookFileHashHistory, bookFiles, books, libraries, libraryFolders } from '../../db/schema';
import type { RequestUser } from '../../common/types/request-user';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { FileLockService, bookOperationLockKey } from '../file-write/file-lock.service';
import { LibraryService } from '../library/library.service';
import { PathPolicyService } from '../path/path-policy.service';
import { inspectEpubMediaOverlayFields } from '../reader/epub/epub-media-overlay-capability';
import { computeFileHash } from '../scanner/lib/hash';
import { uploadError } from './upload-errors';
import { UploadProcessorService } from './upload-processor.service';
import { UploadStorageService } from './upload-storage.service';
import { UploadValidatorService } from './upload-validator.service';

type Db = NodePgDatabase<typeof schema>;

interface ReplaceTarget {
  fileId: number;
  bookId: number;
  libraryId: number;
  absolutePath: string;
  format: string | null;
  role: string;
  fileHash: string | null;
  allowedFormats: string[];
  libraryFolderPath: string;
}

/**
 * Swaps the content of one `book_files` row for an uploaded file. The row is updated in place
 * rather than replaced: reading progress, annotations, KOReader links and TTS positions all
 * cascade from `book_files.id`, so a new row would silently delete them.
 */
@Injectable()
export class BookFileReplaceService {
  private readonly logger = new Logger(BookFileReplaceService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly libraryService: LibraryService,
    private readonly validator: UploadValidatorService,
    private readonly storage: UploadStorageService,
    private readonly processor: UploadProcessorService,
    private readonly pathPolicy: PathPolicyService,
    private readonly lockService: FileLockService,
  ) {}

  async replaceFile(bookId: number, fileId: number, rawFilename: string, fileStream: Readable, user: RequestUser): Promise<ReplaceBookFileResult> {
    const event = 'book.replace_file';
    const startedAt = Date.now();
    this.logger.log(
      `[${event}] [start] bookId=${bookId} fileId=${fileId} userId=${user.id} rawFilename="${sanitizeLogValue(rawFilename)}" - replace book file started`,
    );

    const target = await this.findTarget(bookId, fileId);
    await this.libraryService.verifyUserAccess(user.id, target.libraryId, user.isSuperuser);

    if (target.role !== 'content') {
      throw new BadRequestException('Only content files can be replaced');
    }

    const filename = this.validator.sanitizeFilename(rawFilename);
    const format = this.validator.validateFormat(filename, target.allowedFormats);
    const currentFormat = target.format?.trim().toLowerCase() ?? null;
    if (currentFormat !== format) {
      throw uploadError.formatNotAllowed(`Replacement must be a .${currentFormat ?? 'unknown'} file to match the current file`);
    }

    const { tempPath, sizeBytes } = await this.storage.streamToTemp(fileStream);
    if (sizeBytes === 0) {
      await this.storage.cleanup(tempPath);
      throw uploadError.empty();
    }

    let isPrimary: boolean;
    try {
      await this.validator.validateContent(tempPath, format);
      await this.pathPolicy.assertWithinRoot(target.absolutePath, target.libraryFolderPath);
      const fileHash = await computeFileHash(tempPath);

      isPrimary = await this.lockService.withLock(bookOperationLockKey(bookId), () =>
        this.lockService.withLock(target.absolutePath, () => this.swapAndCommit(target, tempPath, format, fileHash, sizeBytes)),
      );
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'Error';
      const errorMessage = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(
        `[${event}] [fail] bookId=${bookId} fileId=${fileId} userId=${user.id} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${errorMessage}" - replace book file failed`,
      );
      await this.storage.cleanup(tempPath);
      throw err;
    }

    this.queuePostProcessing(bookId, target.absolutePath, format, isPrimary);

    this.logger.log(
      `[${event}] [end] bookId=${bookId} fileId=${fileId} userId=${user.id} format=${format} sizeBytes=${sizeBytes} isPrimary=${isPrimary} durationMs=${Date.now() - startedAt} - replace book file completed`,
    );

    return { id: fileId, bookId, format, sizeBytes, filename: basename(target.absolutePath), isPrimary };
  }

  private async findTarget(bookId: number, fileId: number): Promise<ReplaceTarget> {
    const [row] = await this.db
      .select({
        fileId: bookFiles.id,
        bookId: books.id,
        libraryId: books.libraryId,
        absolutePath: bookFiles.absolutePath,
        format: bookFiles.format,
        role: bookFiles.role,
        fileHash: bookFiles.fileHash,
        allowedFormats: libraries.allowedFormats,
        libraryFolderPath: libraryFolders.path,
      })
      .from(bookFiles)
      .innerJoin(books, eq(bookFiles.bookId, books.id))
      .innerJoin(libraries, eq(books.libraryId, libraries.id))
      .innerJoin(libraryFolders, eq(bookFiles.libraryFolderId, libraryFolders.id))
      .where(and(eq(bookFiles.id, fileId), eq(bookFiles.bookId, bookId)))
      .limit(1);

    if (!row) throw new NotFoundException(`File ${fileId} not found on book ${bookId}`);
    return row;
  }

  /**
   * The old file is moved aside rather than deleted until the database agrees, so any failure
   * puts it back and the book is never left without its file. Staging and backup live next to
   * the target so both renames stay on one filesystem, and their extensions keep the scanner
   * from importing them.
   */
  private async swapAndCommit(target: ReplaceTarget, tempPath: string, format: string, fileHash: string, sizeBytes: number): Promise<boolean> {
    const directory = dirname(target.absolutePath);
    const stagingPath = join(directory, `.bookorbit-replace-${randomUUID()}.tmp`);
    const backupPath = join(directory, `.bookorbit-replace-${randomUUID()}.bak`);

    await this.storage.moveToPath(tempPath, stagingPath);

    let backedUp = false;
    try {
      try {
        await rename(target.absolutePath, backupPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new BadRequestException('The current file is missing on disk. Rescan the library before replacing it.');
        }
        throw err;
      }
      backedUp = true;
      await rename(stagingPath, target.absolutePath);

      const isPrimary = await this.commit(target, format, fileHash, sizeBytes);
      await this.storage.cleanup(backupPath);
      return isPrimary;
    } catch (err) {
      if (backedUp) await this.restoreBackup(target, backupPath);
      await this.storage.cleanup(stagingPath);
      throw err;
    }
  }

  private async commit(target: ReplaceTarget, format: string, fileHash: string, sizeBytes: number): Promise<boolean> {
    const [fileStat, mediaOverlayFields] = await Promise.all([
      stat(target.absolutePath, { bigint: true }),
      inspectEpubMediaOverlayFields(target.absolutePath, format),
    ]);

    return this.db.transaction(async (tx) => {
      const [lockedBook] = await tx
        .select({ primaryFileId: books.primaryFileId })
        .from(books)
        .where(eq(books.id, target.bookId))
        .for('update')
        .limit(1);
      if (!lockedBook) throw new NotFoundException(`Book ${target.bookId} not found`);

      const [updated] = await tx
        .update(bookFiles)
        .set({
          ino: fileStat.ino,
          sizeBytes,
          mtime: fileStat.mtime,
          fileHash,
          // Both describe the old content; the post-commit extraction (or lazy backfill) refills them.
          durationSeconds: null,
          isFixedLayout: null,
          ...mediaOverlayFields,
        })
        .where(and(eq(bookFiles.id, target.fileId), eq(bookFiles.bookId, target.bookId)))
        .returning({ id: bookFiles.id });
      if (!updated) throw new NotFoundException(`File ${target.fileId} not found on book ${target.bookId}`);

      // KOReader identifies documents by this hash, so devices still holding the old version keep syncing to this file.
      if (target.fileHash && target.fileHash !== fileHash) {
        await tx
          .insert(bookFileHashHistory)
          .values({ bookFileId: target.fileId, fileHash: target.fileHash, reason: 'external_change' })
          .onConflictDoNothing();
      }
      await tx.delete(bookFileChapters).where(eq(bookFileChapters.bookFileId, target.fileId));
      await tx.update(books).set({ updatedAt: new Date() }).where(eq(books.id, target.bookId));

      return lockedBook.primaryFileId === target.fileId;
    });
  }

  private async restoreBackup(target: ReplaceTarget, backupPath: string): Promise<void> {
    try {
      await rename(backupPath, target.absolutePath);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error(
        `[book.replace_file_restore] [fail] bookId=${target.bookId} fileId=${target.fileId} path="${sanitizeLogValue(target.absolutePath)}" backupPath="${sanitizeLogValue(backupPath)}" errorClass=${error.name} error="${sanitizeLogValue(error.message)}" - original file could not be restored, backup kept`,
      );
    }
  }

  private queuePostProcessing(bookId: number, absolutePath: string, format: string, isPrimary: boolean): void {
    if (isPrimary) {
      this.processor.extractMetadataAsync(bookId, absolutePath, format);
      return;
    }
    this.processor.extractAudioDurationAsync(bookId, absolutePath, format);
    this.processor.extractAddedAudioChaptersAsync(bookId, format);
    this.processor.reconcileCoversAsync([bookId]);
  }
}
