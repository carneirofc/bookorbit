import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ZipArchive } from 'archiver';
import type { Stats } from 'fs';
import { stat } from 'fs/promises';
import type { ServerResponse } from 'http';

import {
  DEFAULT_BOOK_EXPORT_PART_SIZE_MB,
  isAudioFormat,
  type BookExportScope,
  type BookExportSessionResponse,
  type BookExportSessionStatus,
} from '@bookorbit/types';
import { contentDispositionHeader } from '../../common/utils/content-disposition.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { RequestUser } from '../../common/types/request-user';
import { AppSettingsService } from '../app-settings/app-settings.service';
import { LibraryService } from '../library/library.service';
import { BookExportSessionStore } from './book-export-session.store';
import { BookRepository } from './book.repository';
import { BookService } from './book.service';
import type { CreateExportSessionDto } from './dto/create-export-session.dto';
import { partitionBooksBySize, type ExportBookSize } from './utils/partition-export-books';

export const EXPORT_PART_MAX_FILES = 5000;
const SIZE_SCAN_CHUNK = 1000;
const STREAM_BATCH_SIZE = 200;
const MISSING_FILES_ENTRY = 'MISSING_FILES.txt';

type ExportFileRow = { bookId: number; absolutePath: string; format: string | null; sizeBytes: number | null; mediaOverlayAvailable: boolean };
type PlannedEntry = { absolutePath: string; zipPath: string; stats: Stats };
type BatchPlan = { entries: PlannedEntry[]; missing: string[] };

@Injectable()
export class BookExportService {
  private readonly logger = new Logger(BookExportService.name);

  constructor(
    private readonly bookService: BookService,
    private readonly bookRepo: BookRepository,
    private readonly appSettings: AppSettingsService,
    private readonly libraryService: LibraryService,
    private readonly sessions: BookExportSessionStore,
  ) {}

  async createSession(dto: CreateExportSessionDto, user: RequestUser): Promise<BookExportSessionResponse> {
    const event = 'book.export_session_create';
    const startedAt = Date.now();
    const partSizeMb = dto.partSizeMb ?? DEFAULT_BOOK_EXPORT_PART_SIZE_MB;
    const selectionMode = dto.query ? 'query' : 'ids';
    this.logger.log(
      `[${event}] [start] userId=${user.id} selection=${selectionMode} scope=${dto.scope} partSizeMb=${partSizeMb} - export session create started`,
    );
    try {
      const { query, scope } = dto;
      const resolvedIds = await this.bookService.resolveSelectionToIds(dto, user);
      const orderedIds = query ? [...resolvedIds].sort((a, b) => a - b) : [...new Set(resolvedIds)];
      if (orderedIds.length === 0) throw new BadRequestException('No books selected');

      const sizes = await this.collectBookSizes(orderedIds, scope);
      const parts = partitionBooksBySize(sizes, partSizeMb * 1024 * 1024, EXPORT_PART_MAX_FILES);
      if (parts.length === 0) throw new BadRequestException('None of the selected books have downloadable files');

      const archiveBaseName = await this.resolveArchiveBaseName(query?.libraryId, user);
      const session = this.sessions.create({ userId: user.id, scope, parts: parts.map((p) => p.bookIds), archiveBaseName });
      const totalBytes = parts.reduce((sum, p) => sum + p.bytes, 0);
      const bookCount = sizes.length;

      this.logger.log(
        `[${event}] [end] userId=${user.id} scope=${scope} partSizeMb=${partSizeMb} durationMs=${Date.now() - startedAt} books=${bookCount} skippedBooks=${orderedIds.length - bookCount} parts=${parts.length} totalBytes=${totalBytes} - export session created`,
      );
      return {
        token: session.token,
        scope,
        expiresAt: new Date(session.expiresAt).toISOString(),
        bookCount,
        skippedBookCount: orderedIds.length - bookCount,
        totalBytes,
        parts: parts.map((p, index) => ({ index, bookCount: p.bookIds.length, fileCount: p.fileCount, bytes: p.bytes, oversized: p.oversized })),
        maxConcurrentExports: this.bookService.getExportCapacity(user.id).max,
      };
    } catch (err) {
      const errorClass = err instanceof Error ? err.name : 'Error';
      const errorMessage = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(
        `[${event}] [fail] userId=${user.id} selection=${selectionMode} scope=${dto.scope} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${errorMessage}" - export session create failed`,
      );
      throw err;
    }
  }

  getSessionStatus(token: string, user: RequestUser): BookExportSessionStatus {
    const session = this.sessions.get(token, user.id);
    return {
      activeParts: [...session.activeParts.keys()].sort((a, b) => a - b),
      activeExports: this.bookService.getExportCapacity(user.id).active,
    };
  }

  async streamPart(token: string, index: number, user: RequestUser, raw: ServerResponse): Promise<void> {
    const event = 'book.export_part';
    const startedAt = Date.now();
    const logIds = `userId=${user.id} token=${token.slice(0, 8)} partIndex=${index}`;
    this.logger.log(`[${event}] [start] ${logIds} - export part started`);

    let releaseExportSlot: (() => void) | null = null;
    let releaseActivePart: (() => void) | null = null;
    let files = 0;
    let bytes = 0;
    const missing: string[] = [];
    let clientDisconnected = false;
    let appended = 0;
    let processed = 0;
    let wakeDrainWaiter: (() => void) | null = null;

    const archive = new ZipArchive({ zlib: { level: 0 } });
    const handleDisconnect = () => {
      clientDisconnected = true;
      archive.abort();
      wakeDrainWaiter?.();
    };
    raw.on('close', handleDisconnect);
    const archiveFailure = new Promise<never>((_, reject) => {
      archive.on('warning', reject);
      archive.on('error', reject);
    });
    archiveFailure.catch(() => undefined);
    archive.on('entry', () => {
      processed += 1;
      if (processed >= appended) wakeDrainWaiter?.();
    });
    const drained = () =>
      processed >= appended || clientDisconnected
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            wakeDrainWaiter = () => {
              wakeDrainWaiter = null;
              resolve();
            };
          });

    try {
      const session = this.sessions.get(token, user.id);
      const partBookIds = session.parts[index];
      if (!partBookIds) throw new BadRequestException(`Part ${index} does not exist`);
      const bookIds = await this.bookService.resolveAccessibleExportBookIds(partBookIds, user);
      releaseExportSlot = this.bookService.acquireExportSlot(user.id);
      releaseActivePart = this.sessions.trackActivePart(session, index);

      const partLabel = `part-${String(index + 1).padStart(2, '0')}-of-${String(session.parts.length).padStart(2, '0')}`;
      const archiveName = this.bookService.sanitizeExportArchiveName(`${session.archiveBaseName}-${partLabel}.zip`, 'books.zip');
      raw.setHeader('Content-Type', 'application/zip');
      raw.setHeader('Content-Disposition', contentDispositionHeader('attachment', archiveName, 'books.zip'));
      raw.setHeader('Cache-Control', 'no-store');
      archive.pipe(raw);

      const pattern = await this.appSettings.getDownloadPattern();
      const usedPaths = new Set<string>();
      const batches: number[][] = [];
      for (let i = 0; i < bookIds.length; i += STREAM_BATCH_SIZE) batches.push(bookIds.slice(i, i + STREAM_BATCH_SIZE));

      // Plan the next batch (DB + stat) while the archiver is still reading the current one.
      let nextPlan: Promise<BatchPlan> | null = batches.length > 0 ? this.planBatch(batches[0], session.scope, pattern, usedPaths) : null;
      nextPlan?.catch(() => undefined);
      for (let i = 0; i < batches.length && !clientDisconnected; i++) {
        const plan = await Promise.race([nextPlan as Promise<BatchPlan>, archiveFailure]);
        nextPlan = i + 1 < batches.length ? this.planBatch(batches[i + 1], session.scope, pattern, usedPaths) : null;
        nextPlan?.catch(() => undefined);

        missing.push(...plan.missing);
        for (const entry of plan.entries) {
          archive.file(entry.absolutePath, { name: entry.zipPath, stats: entry.stats });
          appended += 1;
          files += 1;
          bytes += entry.stats.size;
        }
        await Promise.race([drained(), archiveFailure]);
      }

      if (clientDisconnected) {
        this.logger.log(
          `[${event}] [end] ${logIds} durationMs=${Date.now() - startedAt} files=${files} disconnected=true - export part disconnected`,
        );
        return;
      }

      if (missing.length > 0) {
        const report = `The following files were missing on disk and were skipped:\n\n${missing.join('\n')}\n`;
        archive.append(report, { name: this.uniqueName(MISSING_FILES_ENTRY, usedPaths) });
      }
      await Promise.race([archive.finalize(), archiveFailure]);

      this.logger.log(
        `[${event}] [end] ${logIds} durationMs=${Date.now() - startedAt} books=${bookIds.length} files=${files} skipped=${missing.length} bytes=${bytes} - export part completed`,
      );
    } catch (err) {
      if (clientDisconnected) {
        this.logger.log(
          `[${event}] [end] ${logIds} durationMs=${Date.now() - startedAt} files=${files} disconnected=true - export part disconnected`,
        );
        return;
      }
      const errorClass = err instanceof Error ? err.name : 'Error';
      const errorMessage = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(
        `[${event}] [fail] ${logIds} durationMs=${Date.now() - startedAt} files=${files} errorClass=${errorClass} error="${errorMessage}" - export part failed`,
      );
      if (raw.headersSent) {
        archive.abort();
        raw.destroy(err instanceof Error ? err : undefined);
        return;
      }
      throw err;
    } finally {
      releaseActivePart?.();
      releaseExportSlot?.();
      raw.off('close', handleDisconnect);
    }
  }

  private async collectBookSizes(bookIds: number[], scope: BookExportScope): Promise<ExportBookSize[]> {
    const sizes: ExportBookSize[] = [];
    for (let i = 0; i < bookIds.length; i += SIZE_SCAN_CHUNK) {
      const chunk = bookIds.slice(i, i + SIZE_SCAN_CHUNK);
      const rows = await this.fetchExportFiles(chunk, scope);
      const byBook = new Map<number, ExportBookSize>();
      for (const row of rows) {
        const entry = byBook.get(row.bookId) ?? { bookId: row.bookId, bytes: 0, fileCount: 0 };
        entry.bytes += row.sizeBytes ?? 0;
        entry.fileCount += 1;
        byBook.set(row.bookId, entry);
      }
      for (const id of chunk) {
        const entry = byBook.get(id);
        if (entry) sizes.push(entry);
      }
    }
    return sizes;
  }

  private async fetchExportFiles(bookIds: number[], scope: BookExportScope): Promise<ExportFileRow[]> {
    if (scope === 'primary') return this.bookRepo.findPrimaryFilesByBookIds(bookIds);
    const rows = await this.bookRepo.findAllFilesByBookIds(bookIds);
    return scope === 'audio' ? rows.filter((row) => !!row.format && isAudioFormat(row.format)) : rows;
  }

  private async planBatch(bookIds: number[], scope: BookExportScope, pattern: string, usedPaths: Set<string>): Promise<BatchPlan> {
    const [rows, metadataRows] = await Promise.all([this.fetchExportFiles(bookIds, scope), this.bookRepo.findPatternMetadataByBookIds(bookIds)]);
    const metadataByBookId = new Map(metadataRows.map((row) => [row.bookId, row]));
    const order = new Map(bookIds.map((id, i) => [id, i]));
    rows.sort((a, b) => (order.get(a.bookId) ?? 0) - (order.get(b.bookId) ?? 0));

    const statResults = await Promise.all(rows.map((row) => stat(row.absolutePath).catch(() => null)));
    const entries: PlannedEntry[] = [];
    const missing: string[] = [];
    rows.forEach((row, i) => {
      const stats = statResults[i];
      const zipPath = this.bookService.buildExportZipPath(row, metadataByBookId.get(row.bookId), pattern, usedPaths);
      if (!stats || !stats.isFile()) {
        missing.push(zipPath);
        return;
      }
      entries.push({ absolutePath: row.absolutePath, zipPath, stats });
    });
    return { entries, missing };
  }

  private async resolveArchiveBaseName(libraryId: number | undefined, user: RequestUser): Promise<string> {
    if (libraryId === undefined) return 'books';
    const libraries = await this.libraryService.findAll(user);
    const name = libraries.find((l) => l.id === libraryId)?.name?.trim();
    return name ? this.bookService.sanitizeExportArchiveName(name, 'books') : 'books';
  }

  private uniqueName(name: string, used: Set<string>): string {
    let candidate = name;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${name.replace(/\.txt$/, '')} (${suffix++}).txt`;
    used.add(candidate);
    return candidate;
  }
}
