vi.mock('fs/promises', async () => {
  const actual = await vi.importActual('fs/promises');
  return { ...actual, rename: vi.fn(), stat: vi.fn() };
});
vi.mock('../scanner/lib/hash', () => ({ computeFileHash: vi.fn() }));
vi.mock('../reader/epub/epub-media-overlay-capability', () => ({ inspectEpubMediaOverlayFields: vi.fn() }));

import { rename, stat } from 'fs/promises';
import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { bookFileChapters, bookFileHashHistory, bookFiles, books } from '../../db/schema';
import { FileLockService } from '../file-write/file-lock.service';
import { inspectEpubMediaOverlayFields } from '../reader/epub/epub-media-overlay-capability';
import { computeFileHash } from '../scanner/lib/hash';
import { BookFileReplaceService } from './book-file-replace.service';

const mockRename = rename as MockedFunction<typeof rename>;
const mockStat = stat as MockedFunction<typeof stat>;
const mockComputeFileHash = computeFileHash as MockedFunction<typeof computeFileHash>;
const mockInspectMediaOverlay = inspectEpubMediaOverlayFields as MockedFunction<typeof inspectEpubMediaOverlayFields>;

const ORIGINAL_PATH = '/library/Fic/fic.epub';

function targetRow(overrides: Record<string, unknown> = {}) {
  return {
    fileId: 12,
    bookId: 7,
    libraryId: 3,
    absolutePath: ORIGINAL_PATH,
    format: 'epub',
    role: 'content',
    fileHash: 'old-hash',
    allowedFormats: [],
    libraryFolderPath: '/library',
    ...overrides,
  };
}

function targetSelectChain(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const join3 = vi.fn().mockReturnValue({ where });
  const join2 = vi.fn().mockReturnValue({ innerJoin: join3 });
  const join1 = vi.fn().mockReturnValue({ innerJoin: join2 });
  return { from: vi.fn().mockReturnValue({ innerJoin: join1 }) };
}

describe('BookFileReplaceService', () => {
  const lockedBookLimit = vi.fn();
  const fileUpdateReturning = vi.fn();
  const fileUpdateSet = vi.fn();
  const bookUpdateSet = vi.fn();
  const historyValues = vi.fn();
  const chaptersDeleteWhere = vi.fn();

  const tx = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  };

  const db = {
    select: vi.fn(),
    transaction: vi.fn(),
  };

  const libraryService = { verifyUserAccess: vi.fn() };
  const validator = { sanitizeFilename: vi.fn(), validateFormat: vi.fn(), validateContent: vi.fn() };
  const storage = { streamToTemp: vi.fn(), moveToPath: vi.fn(), cleanup: vi.fn() };
  const processor = {
    extractMetadataAsync: vi.fn(),
    extractAudioDurationAsync: vi.fn(),
    extractAddedAudioChaptersAsync: vi.fn(),
    reconcileCoversAsync: vi.fn(),
  };
  const pathPolicy = { assertWithinRoot: vi.fn() };
  const user = { id: 5, isSuperuser: false, permissions: [] } as any;

  let service: BookFileReplaceService;

  function renamedPaths() {
    return mockRename.mock.calls.map(([from, to]) => [String(from), String(to)]);
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    service = new BookFileReplaceService(
      db as any,
      libraryService as any,
      validator as any,
      storage as any,
      processor as any,
      pathPolicy as any,
      new FileLockService(),
    );

    db.select.mockReturnValue(targetSelectChain([targetRow()]));
    db.transaction.mockImplementation(async (callback: (trx: typeof tx) => Promise<unknown>) => callback(tx));
    libraryService.verifyUserAccess.mockResolvedValue(undefined);
    validator.sanitizeFilename.mockImplementation((name: string) => name);
    validator.validateFormat.mockReturnValue('epub');
    validator.validateContent.mockResolvedValue(undefined);
    storage.streamToTemp.mockResolvedValue({ tempPath: '/tmp/upload.bin', sizeBytes: 4096 });
    storage.moveToPath.mockResolvedValue(undefined);
    storage.cleanup.mockResolvedValue(undefined);
    pathPolicy.assertWithinRoot.mockResolvedValue(ORIGINAL_PATH);
    mockComputeFileHash.mockResolvedValue('new-hash');
    mockRename.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ ino: 99n, mtime: new Date('2026-01-01T00:00:00Z') } as any);
    mockInspectMediaOverlay.mockResolvedValue({
      mediaOverlayAvailable: false,
      mediaOverlayDurationSeconds: null,
      mediaOverlayCheckedAt: null,
    });

    lockedBookLimit.mockResolvedValue([{ primaryFileId: 12 }]);
    tx.select.mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ for: vi.fn().mockReturnValue({ limit: lockedBookLimit }) }) }),
    });
    fileUpdateReturning.mockResolvedValue([{ id: 12 }]);
    fileUpdateSet.mockReturnValue({ where: vi.fn().mockReturnValue({ returning: fileUpdateReturning }) });
    bookUpdateSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    tx.update.mockImplementation((table: unknown) => (table === bookFiles ? { set: fileUpdateSet } : { set: bookUpdateSet }));
    historyValues.mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) });
    tx.insert.mockReturnValue({ values: historyValues });
    chaptersDeleteWhere.mockResolvedValue(undefined);
    tx.delete.mockReturnValue({ where: chaptersDeleteWhere });
  });

  describe('success', () => {
    it('swaps the file on disk in place and updates the same book_files row', async () => {
      const result = await service.replaceFile(7, 12, 'fic.epub', {} as any, user);

      expect(result).toEqual({ id: 12, bookId: 7, format: 'epub', sizeBytes: 4096, filename: 'fic.epub', isPrimary: true });

      const stagingPath = storage.moveToPath.mock.calls[0]![1] as string;
      expect(storage.moveToPath).toHaveBeenCalledWith('/tmp/upload.bin', expect.stringMatching(/^\/library\/Fic\/\.bookorbit-replace-.+\.tmp$/));
      const [[originalFrom, backupPath], [stagingFrom, stagingTo]] = renamedPaths();
      expect(originalFrom).toBe(ORIGINAL_PATH);
      expect(backupPath).toMatch(/^\/library\/Fic\/\.bookorbit-replace-.+\.bak$/);
      expect(stagingFrom).toBe(stagingPath);
      expect(stagingTo).toBe(ORIGINAL_PATH);

      expect(tx.update).toHaveBeenCalledWith(bookFiles);
      expect(fileUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({ ino: 99n, sizeBytes: 4096, fileHash: 'new-hash', durationSeconds: null, isFixedLayout: null }),
      );
      expect(tx.insert).toHaveBeenCalledWith(bookFileHashHistory);
      expect(historyValues).toHaveBeenCalledWith({ bookFileId: 12, fileHash: 'old-hash', reason: 'external_change' });
      expect(tx.delete).toHaveBeenCalledWith(bookFileChapters);
      expect(tx.update).toHaveBeenCalledWith(books);

      expect(storage.cleanup).toHaveBeenCalledWith(backupPath);
    });

    it('never deletes the book_files row, so per-file reading data is preserved', async () => {
      await service.replaceFile(7, 12, 'fic.epub', {} as any, user);

      expect(tx.delete).not.toHaveBeenCalledWith(bookFiles);
      expect(tx.delete).not.toHaveBeenCalledWith(books);
      expect(tx.insert).not.toHaveBeenCalledWith(bookFiles);
    });

    it('re-extracts book metadata when the replaced file is the primary', async () => {
      await service.replaceFile(7, 12, 'fic.epub', {} as any, user);

      expect(processor.extractMetadataAsync).toHaveBeenCalledWith(7, ORIGINAL_PATH, 'epub');
      expect(processor.reconcileCoversAsync).not.toHaveBeenCalled();
    });

    it('only refreshes per-file data when the replaced file is not the primary', async () => {
      lockedBookLimit.mockResolvedValue([{ primaryFileId: 40 }]);

      const result = await service.replaceFile(7, 12, 'fic.epub', {} as any, user);

      expect(result.isPrimary).toBe(false);
      expect(processor.extractMetadataAsync).not.toHaveBeenCalled();
      expect(processor.extractAudioDurationAsync).toHaveBeenCalledWith(7, ORIGINAL_PATH, 'epub');
      expect(processor.reconcileCoversAsync).toHaveBeenCalledWith([7]);
    });

    it('skips hash history when the file had no recorded hash', async () => {
      db.select.mockReturnValue(targetSelectChain([targetRow({ fileHash: null })]));

      await service.replaceFile(7, 12, 'fic.epub', {} as any, user);

      expect(tx.insert).not.toHaveBeenCalled();
    });

    it('swaps the file at its current path when the book was renamed while the upload streamed', async () => {
      const renamedPath = '/library/Fic/renamed.epub';
      storage.streamToTemp.mockImplementation(() => {
        // Another book can now own ORIGINAL_PATH; replacing it would hand that book this upload.
        db.select.mockReturnValue(targetSelectChain([targetRow({ absolutePath: renamedPath })]));
        return Promise.resolve({ tempPath: '/tmp/upload.bin', sizeBytes: 4096 });
      });

      const result = await service.replaceFile(7, 12, 'fic.epub', {} as any, user);

      const touchedPaths = renamedPaths().flat();
      expect(touchedPaths).not.toContain(ORIGINAL_PATH);
      const [[originalFrom], [, stagingTo]] = renamedPaths();
      expect(originalFrom).toBe(renamedPath);
      expect(stagingTo).toBe(renamedPath);
      expect(pathPolicy.assertWithinRoot).toHaveBeenCalledWith(renamedPath, '/library');
      expect(result.filename).toBe('renamed.epub');
      expect(processor.extractMetadataAsync).toHaveBeenCalledWith(7, renamedPath, 'epub');
    });
  });

  describe('rejection before touching disk', () => {
    it('throws NotFoundException when the file does not belong to the book', async () => {
      db.select.mockReturnValue(targetSelectChain([]));

      await expect(service.replaceFile(7, 999, 'fic.epub', {} as any, user)).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.streamToTemp).not.toHaveBeenCalled();
    });

    it('propagates ForbiddenException when the user cannot access the library', async () => {
      libraryService.verifyUserAccess.mockRejectedValue(new ForbiddenException('No access'));

      await expect(service.replaceFile(7, 12, 'fic.epub', {} as any, user)).rejects.toBeInstanceOf(ForbiddenException);
      expect(storage.streamToTemp).not.toHaveBeenCalled();
    });

    it('rejects non-content files', async () => {
      db.select.mockReturnValue(targetSelectChain([targetRow({ role: 'cover' })]));

      await expect(service.replaceFile(7, 12, 'fic.epub', {} as any, user)).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.streamToTemp).not.toHaveBeenCalled();
    });

    it('rejects a replacement in a different format', async () => {
      validator.validateFormat.mockReturnValue('pdf');

      await expect(service.replaceFile(7, 12, 'fic.pdf', {} as any, user)).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.streamToTemp).not.toHaveBeenCalled();
    });

    it('rejects an empty upload and removes the temp file', async () => {
      storage.streamToTemp.mockResolvedValue({ tempPath: '/tmp/upload.bin', sizeBytes: 0 });

      await expect(service.replaceFile(7, 12, 'fic.epub', {} as any, user)).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.cleanup).toHaveBeenCalledWith('/tmp/upload.bin');
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('rejects invalid content without touching the original file or the database', async () => {
      validator.validateContent.mockRejectedValue(new BadRequestException('File content does not match the epub format'));

      await expect(service.replaceFile(7, 12, 'fic.epub', {} as any, user)).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.moveToPath).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(storage.cleanup).toHaveBeenCalledWith('/tmp/upload.bin');
    });
  });

  describe('rollback', () => {
    it('restores the original file when the database update fails', async () => {
      fileUpdateReturning.mockRejectedValue(new Error('DB error'));

      await expect(service.replaceFile(7, 12, 'fic.epub', {} as any, user)).rejects.toThrow('DB error');

      const calls = renamedPaths();
      const backupPath = calls[0]![1];
      expect(calls[2]).toEqual([backupPath, ORIGINAL_PATH]);
      expect(storage.cleanup).not.toHaveBeenCalledWith(backupPath);
      expect(processor.extractMetadataAsync).not.toHaveBeenCalled();
    });

    it('restores the original file when the row disappeared concurrently', async () => {
      fileUpdateReturning.mockResolvedValue([]);

      await expect(service.replaceFile(7, 12, 'fic.epub', {} as any, user)).rejects.toBeInstanceOf(NotFoundException);

      const calls = renamedPaths();
      expect(calls[2]).toEqual([calls[0]![1], ORIGINAL_PATH]);
    });

    it('restores the original file and removes staging when moving the new file into place fails', async () => {
      mockRename.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('EACCES')).mockResolvedValue(undefined);

      await expect(service.replaceFile(7, 12, 'fic.epub', {} as any, user)).rejects.toThrow('EACCES');

      const calls = renamedPaths();
      const stagingPath = storage.moveToPath.mock.calls[0]![1] as string;
      expect(calls[2]).toEqual([calls[0]![1], ORIGINAL_PATH]);
      expect(storage.cleanup).toHaveBeenCalledWith(stagingPath);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('rejects and cleans up staging when the original file is missing on disk', async () => {
      mockRename.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      await expect(service.replaceFile(7, 12, 'fic.epub', {} as any, user)).rejects.toBeInstanceOf(BadRequestException);

      const stagingPath = storage.moveToPath.mock.calls[0]![1] as string;
      expect(mockRename).toHaveBeenCalledTimes(1);
      expect(storage.cleanup).toHaveBeenCalledWith(stagingPath);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('keeps the backup and logs when restoring the original fails', async () => {
      fileUpdateReturning.mockRejectedValue(new Error('DB error'));
      mockRename.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('EIO'));
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(service.replaceFile(7, 12, 'fic.epub', {} as any, user)).rejects.toThrow('DB error');

      const backupPath = renamedPaths()[0]![1];
      expect(storage.cleanup).not.toHaveBeenCalledWith(backupPath);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[book.replace_file_restore] [fail]'));
    });
  });
});
