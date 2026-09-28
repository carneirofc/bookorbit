import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import type { ServerResponse } from 'http';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { PassThrough } from 'stream';
import unzipper from 'unzipper';

import type { RequestUser } from '../../common/types/request-user';
import { AppSettingsService } from '../app-settings/app-settings.service';
import { LibraryService } from '../library/library.service';
import { BookExportService } from './book-export.service';
import { BookExportSessionStore } from './book-export-session.store';
import { BookRepository } from './book.repository';
import { BookService } from './book.service';

const user = { id: 7 } as RequestUser;

function fakeResponse() {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const headers: Record<string, string> = {};
  const res = Object.assign(stream, {
    headersSent: false,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
  });
  const finished = new Promise<void>((resolve) => stream.on('end', resolve));
  return { res: res as unknown as ServerResponse, headers, body: async () => (await finished, Buffer.concat(chunks)) };
}

describe('BookExportService', () => {
  let dir: string;
  let service: BookExportService;
  let files: { bookId: number; absolutePath: string; format: string | null; sizeBytes: number | null }[];
  const releaseSlot = vi.fn();
  const bookService = {
    resolveSelectionToIds: vi.fn(),
    resolveAccessibleExportBookIds: vi.fn((ids: number[]) => Promise.resolve(ids)),
    acquireExportSlot: vi.fn(() => releaseSlot),
    getExportCapacity: vi.fn(() => ({ active: 0, max: 2 })),
    buildExportZipPath: vi.fn((file: { absolutePath: string }, _meta: unknown, _pattern: string, used: Set<string>) => {
      const name = basename(file.absolutePath);
      used.add(name);
      return name;
    }),
    sanitizeExportArchiveName: vi.fn((raw: string) => raw),
  };
  const bookRepo = {
    findPrimaryFilesByBookIds: vi.fn((ids: number[]) => Promise.resolve(files.filter((f) => ids.includes(f.bookId)))),
    findAllFilesByBookIds: vi.fn((ids: number[]) =>
      Promise.resolve(files.filter((f) => ids.includes(f.bookId)).map((f) => ({ ...f, sortOrder: 0 }))),
    ),
    findPatternMetadataByBookIds: vi.fn(() => Promise.resolve([])),
  };
  const appSettings = { getDownloadPattern: vi.fn(() => Promise.resolve('')) };
  const libraryService = { findAll: vi.fn(() => Promise.resolve([{ id: 3, name: 'Fiction' }])) };
  let store: BookExportSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'book-export-'));
    vi.clearAllMocks();
    bookService.resolveAccessibleExportBookIds.mockImplementation((ids: number[]) => Promise.resolve(ids));
    bookService.getExportCapacity.mockImplementation(() => ({ active: 0, max: 2 }));
    appSettings.getDownloadPattern.mockImplementation(() => Promise.resolve(''));
    const moduleRef = await Test.createTestingModule({
      providers: [
        BookExportService,
        BookExportSessionStore,
        { provide: BookService, useValue: bookService },
        { provide: BookRepository, useValue: bookRepo },
        { provide: AppSettingsService, useValue: appSettings },
        { provide: LibraryService, useValue: libraryService },
      ],
    }).compile();
    service = moduleRef.get(BookExportService);
    store = moduleRef.get(BookExportSessionStore);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function addFile(bookId: number, name: string, content: string, onDisk = true, format = 'epub') {
    const absolutePath = join(dir, name);
    if (onDisk) await writeFile(absolutePath, content);
    files.push({ bookId, absolutePath, format, sizeBytes: content.length });
  }

  async function prepareSession(ids: number[], scope: 'primary' | 'all' | 'audio' = 'primary') {
    bookService.resolveSelectionToIds.mockResolvedValue(ids);
    return service.createSession({ bookIds: ids, scope }, user);
  }

  it('splits the selection into parts and skips books without files', async () => {
    const mb = 1024 * 1024;
    files = [
      { bookId: 1, absolutePath: join(dir, 'a.epub'), format: 'epub', sizeBytes: 400 * mb },
      { bookId: 2, absolutePath: join(dir, 'b.epub'), format: 'epub', sizeBytes: 300 * mb },
      { bookId: 3, absolutePath: join(dir, 'c.epub'), format: 'epub', sizeBytes: 200 * mb },
    ];
    bookService.resolveSelectionToIds.mockResolvedValue([3, 1, 2, 4]);

    const session = await service.createSession({ query: { libraryId: 3 }, scope: 'primary', partSizeMb: 500 }, user);

    expect(session.bookCount).toBe(3);
    expect(session.skippedBookCount).toBe(1);
    expect(session.parts.map((p) => p.bookCount)).toEqual([1, 2]);
    expect(session.totalBytes).toBe(900 * mb);
  });

  it('streams a part as a zip, reporting files missing on disk', async () => {
    files = [];
    await addFile(1, 'one.epub', 'first book');
    await addFile(2, 'two.epub', 'second book');
    await addFile(3, 'gone.epub', 'never written', false);
    bookService.resolveSelectionToIds.mockResolvedValue([1, 2, 3]);
    const session = await service.createSession({ query: { libraryId: 3 }, scope: 'primary' }, user);

    const { res, headers, body } = fakeResponse();
    await service.streamPart(session.token, 0, user, res);
    const zip = await unzipper.Open.buffer(await body());

    const names = zip.files.map((f) => f.path).sort();
    expect(names).toEqual(['MISSING_FILES.txt', 'one.epub', 'two.epub']);
    const report = await zip.files.find((f) => f.path === 'MISSING_FILES.txt')!.buffer();
    expect(report.toString()).toContain('gone.epub');
    expect(headers['content-type']).toBe('application/zip');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['content-disposition']).toContain('Fiction-part-01-of-01.zip');
    expect(releaseSlot).toHaveBeenCalledTimes(1);
  });

  it('streams every file when a part spans several batches', async () => {
    files = [];
    const ids = Array.from({ length: 450 }, (_, i) => i + 1);
    for (const id of ids) await addFile(id, `book-${id}.epub`, `content ${id}`);
    bookService.resolveSelectionToIds.mockResolvedValue(ids);
    const session = await service.createSession({ bookIds: ids, scope: 'all' }, user);

    const { res, body } = fakeResponse();
    await service.streamPart(session.token, 0, user, res);
    const zip = await unzipper.Open.buffer(await body());

    expect(zip.files).toHaveLength(450);
    expect(bookRepo.findAllFilesByBookIds).toHaveBeenCalledTimes(4);
  });

  it('rejects parts of a session owned by another user', async () => {
    files = [];
    await addFile(1, 'one.epub', 'first book');
    bookService.resolveSelectionToIds.mockResolvedValue([1]);
    const session = await service.createSession({ bookIds: [1], scope: 'primary' }, user);

    const { res } = fakeResponse();
    await expect(service.streamPart(session.token, 0, { id: 99 } as RequestUser, res)).rejects.toThrow(NotFoundException);
    expect(bookService.acquireExportSlot).not.toHaveBeenCalled();
  });

  describe('createSession', () => {
    beforeEach(() => {
      files = [];
    });

    it('rejects a selection that resolves to no books', async () => {
      bookService.resolveSelectionToIds.mockResolvedValue([]);

      await expect(service.createSession({ query: { libraryId: 3 }, scope: 'primary' }, user)).rejects.toThrow(BadRequestException);
      expect(bookRepo.findPrimaryFilesByBookIds).not.toHaveBeenCalled();
    });

    it('rejects a selection where no book has a downloadable file', async () => {
      bookService.resolveSelectionToIds.mockResolvedValue([1, 2]);

      await expect(service.createSession({ bookIds: [1, 2], scope: 'primary' }, user)).rejects.toThrow(
        'None of the selected books have downloadable files',
      );
    });

    it('keeps explicit ids in selection order and drops duplicates', async () => {
      await addFile(1, 'one.epub', 'a', false);
      await addFile(2, 'two.epub', 'b', false);
      await addFile(3, 'three.epub', 'c', false);

      const session = await prepareSession([3, 1, 3, 2]);

      expect(store.get(session.token, user.id).parts).toEqual([[3, 1, 2]]);
      expect(session.bookCount).toBe(3);
      expect(session.skippedBookCount).toBe(0);
    });

    it('orders query selections by book id', async () => {
      await addFile(1, 'one.epub', 'a', false);
      await addFile(2, 'two.epub', 'b', false);
      await addFile(3, 'three.epub', 'c', false);
      bookService.resolveSelectionToIds.mockResolvedValue([3, 1, 2]);

      const session = await service.createSession({ query: { libraryId: 3 }, scope: 'primary' }, user);

      expect(store.get(session.token, user.id).parts).toEqual([[1, 2, 3]]);
    });

    it('counts only audio files for the audio scope', async () => {
      await addFile(1, 'one.epub', 'ebook', false);
      await addFile(1, 'one.mp3', 'audio-one', false, 'mp3');
      await addFile(2, 'two.epub', 'ebook only', false);

      const session = await prepareSession([1, 2], 'audio');

      expect(bookRepo.findAllFilesByBookIds).toHaveBeenCalledWith([1, 2]);
      expect(bookRepo.findPrimaryFilesByBookIds).not.toHaveBeenCalled();
      expect(session.bookCount).toBe(1);
      expect(session.skippedBookCount).toBe(1);
      expect(session.totalBytes).toBe('audio-one'.length);
      expect(session.parts).toEqual([{ index: 0, bookCount: 1, fileCount: 1, bytes: 'audio-one'.length, oversized: false }]);
    });

    it('treats unknown file sizes as zero bytes', async () => {
      files = [{ bookId: 1, absolutePath: join(dir, 'a.epub'), format: 'epub', sizeBytes: null }];

      const session = await prepareSession([1]);

      expect(session.totalBytes).toBe(0);
      expect(session.parts).toHaveLength(1);
    });

    it('uses the default part size when none is requested', async () => {
      const mb = 1024 * 1024;
      files = [
        { bookId: 1, absolutePath: join(dir, 'a.epub'), format: 'epub', sizeBytes: 600 * mb },
        { bookId: 2, absolutePath: join(dir, 'b.epub'), format: 'epub', sizeBytes: 400 * mb },
        { bookId: 3, absolutePath: join(dir, 'c.epub'), format: 'epub', sizeBytes: 100 * mb },
      ];

      const session = await prepareSession([1, 2, 3]);

      expect(session.parts.map((p) => p.bookCount)).toEqual([2, 1]);
    });

    it('flags a book larger than the part size as an oversized part', async () => {
      const mb = 1024 * 1024;
      files = [
        { bookId: 1, absolutePath: join(dir, 'a.epub'), format: 'epub', sizeBytes: 10 * mb },
        { bookId: 2, absolutePath: join(dir, 'b.m4b'), format: 'm4b', sizeBytes: 900 * mb },
      ];
      bookService.resolveSelectionToIds.mockResolvedValue([1, 2]);

      const session = await service.createSession({ bookIds: [1, 2], scope: 'primary', partSizeMb: 500 }, user);

      expect(session.parts.map((p) => p.oversized)).toEqual([false, true]);
    });

    it('names archives after the library, falling back to "books"', async () => {
      await addFile(1, 'one.epub', 'a', false);

      const byIds = await prepareSession([1]);
      bookService.resolveSelectionToIds.mockResolvedValue([1]);
      const byLibrary = await service.createSession({ query: { libraryId: 3 }, scope: 'primary' }, user);
      const byUnknownLibrary = await service.createSession({ query: { libraryId: 404 }, scope: 'primary' }, user);

      expect(store.get(byIds.token, user.id).archiveBaseName).toBe('books');
      expect(store.get(byLibrary.token, user.id).archiveBaseName).toBe('Fiction');
      expect(store.get(byUnknownLibrary.token, user.id).archiveBaseName).toBe('books');
      expect(libraryService.findAll).toHaveBeenCalledWith(user);
    });

    it('returns an ISO expiry and a session token owned by the caller', async () => {
      await addFile(1, 'one.epub', 'a', false);

      const session = await prepareSession([1]);

      expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());
      expect(store.get(session.token, user.id).userId).toBe(user.id);
    });

    it('reports the per-user concurrent export limit', async () => {
      files = [];
      await addFile(1, 'one.epub', 'first book');

      const session = await prepareSession([1]);

      expect(session.maxConcurrentExports).toBe(2);
    });

    it('propagates selection access errors', async () => {
      bookService.resolveSelectionToIds.mockRejectedValue(new ForbiddenException('Library 9 is not accessible'));

      await expect(service.createSession({ query: { libraryId: 9 }, scope: 'primary' }, user)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('streamPart', () => {
    beforeEach(() => {
      files = [];
    });

    it('rejects an index outside the session without taking an export slot', async () => {
      await addFile(1, 'one.epub', 'first book');
      const session = await prepareSession([1]);

      const { res } = fakeResponse();
      await expect(service.streamPart(session.token, 1, user, res)).rejects.toThrow(BadRequestException);
      expect(bookService.acquireExportSlot).not.toHaveBeenCalled();
    });

    it('fails before taking an export slot when library access was revoked', async () => {
      await addFile(1, 'one.epub', 'first book');
      const session = await prepareSession([1]);
      bookService.resolveAccessibleExportBookIds.mockRejectedValueOnce(new ForbiddenException());

      const { res } = fakeResponse();
      await expect(service.streamPart(session.token, 0, user, res)).rejects.toThrow(ForbiddenException);
      expect(bookService.acquireExportSlot).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown session', 'unknown', 0, () => undefined],
      ['a missing part', null, 5, () => undefined],
      [
        'the concurrency limit',
        null,
        0,
        () =>
          bookService.acquireExportSlot.mockImplementationOnce(() => {
            throw new HttpException('Too many concurrent exports', HttpStatus.TOO_MANY_REQUESTS);
          }),
      ],
    ])('logs a fail line when rejected by %s', async (_label, tokenOverride, index, arrange) => {
      await addFile(1, 'one.epub', 'first book');
      const session = await prepareSession([1]);
      arrange();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const { res } = fakeResponse();
      await expect(service.streamPart(tokenOverride ?? session.token, index, user, res)).rejects.toThrow();

      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[book\.export_part\] \[fail\] userId=7 .*errorClass=\w+/));
      expect(releaseSlot).not.toHaveBeenCalled();
      expect(res.listenerCount('close')).toBe(0);
      warn.mockRestore();
    });

    it('reports a part as active only while it streams', async () => {
      await addFile(1, 'one.epub', 'first book');
      const session = await prepareSession([1]);
      const { res, body } = fakeResponse();
      let statusWhileStreaming: unknown;
      appSettings.getDownloadPattern.mockImplementationOnce(() => {
        statusWhileStreaming = service.getSessionStatus(session.token, user);
        return Promise.resolve('');
      });
      bookService.getExportCapacity.mockReturnValue({ active: 1, max: 2 });

      await service.streamPart(session.token, 0, user, res);
      await body();

      expect(statusWhileStreaming).toEqual({ activeParts: [0], activeExports: 1 });
      expect(service.getSessionStatus(session.token, user).activeParts).toEqual([]);
    });

    it('does not report a session status to another user', async () => {
      await addFile(1, 'one.epub', 'first book');
      const session = await prepareSession([1]);

      expect(() => service.getSessionStatus(session.token, { id: 99 } as RequestUser)).toThrow(NotFoundException);
    });

    it('skips books deleted after the session was prepared', async () => {
      await addFile(1, 'one.epub', 'first book');
      await addFile(2, 'two.epub', 'second book');
      const session = await prepareSession([1, 2]);
      bookService.resolveAccessibleExportBookIds.mockResolvedValueOnce([2]);

      const { res, body } = fakeResponse();
      await service.streamPart(session.token, 0, user, res);
      const zip = await unzipper.Open.buffer(await body());

      expect(bookService.resolveAccessibleExportBookIds).toHaveBeenCalledWith([1, 2], user);
      expect(zip.files.map((f) => f.path)).toEqual(['two.epub']);
    });

    it('streams only audio files for an audio session', async () => {
      await addFile(1, 'one.epub', 'ebook');
      await addFile(1, 'one.mp3', 'audio', true, 'mp3');
      const session = await prepareSession([1], 'audio');

      const { res, body } = fakeResponse();
      await service.streamPart(session.token, 0, user, res);
      const zip = await unzipper.Open.buffer(await body());

      expect(zip.files.map((f) => f.path)).toEqual(['one.mp3']);
    });

    it('names each part archive with its position in the session', async () => {
      const mb = 1024 * 1024;
      files = [
        { bookId: 1, absolutePath: join(dir, 'a.epub'), format: 'epub', sizeBytes: 400 * mb },
        { bookId: 2, absolutePath: join(dir, 'b.epub'), format: 'epub', sizeBytes: 400 * mb },
      ];
      bookService.resolveSelectionToIds.mockResolvedValue([1, 2]);
      const session = await service.createSession({ bookIds: [1, 2], scope: 'primary', partSizeMb: 500 }, user);

      const { res, headers, body } = fakeResponse();
      await service.streamPart(session.token, 1, user, res);
      await body();

      expect(headers['content-disposition']).toContain('books-part-02-of-02.zip');
    });

    it('does not overwrite a book file that is itself named MISSING_FILES.txt', async () => {
      await addFile(1, 'MISSING_FILES.txt', 'a real book');
      await addFile(2, 'gone.epub', 'never written', false);
      const session = await prepareSession([1, 2]);

      const { res, body } = fakeResponse();
      await service.streamPart(session.token, 0, user, res);
      const zip = await unzipper.Open.buffer(await body());

      const names = zip.files.map((f) => f.path).sort();
      expect(names).toEqual(['MISSING_FILES (2).txt', 'MISSING_FILES.txt']);
      const book = await zip.files.find((f) => f.path === 'MISSING_FILES.txt')!.buffer();
      expect(book.toString()).toBe('a real book');
    });

    it('rethrows and releases the slot when it fails before any bytes are sent', async () => {
      await addFile(1, 'one.epub', 'first book');
      const session = await prepareSession([1]);
      appSettings.getDownloadPattern.mockRejectedValueOnce(new Error('settings unavailable'));

      const { res } = fakeResponse();
      await expect(service.streamPart(session.token, 0, user, res)).rejects.toThrow('settings unavailable');
      expect(releaseSlot).toHaveBeenCalledTimes(1);
    });

    it('destroys the response instead of throwing when it fails mid-stream', async () => {
      await addFile(1, 'one.epub', 'first book');
      const session = await prepareSession([1]);
      const failure = new Error('settings unavailable');
      appSettings.getDownloadPattern.mockRejectedValueOnce(failure);

      const { res } = fakeResponse();
      Object.assign(res, { headersSent: true });
      const destroy = vi.spyOn(res, 'destroy').mockImplementation(() => res);
      await expect(service.streamPart(session.token, 0, user, res)).resolves.toBeUndefined();

      expect(destroy).toHaveBeenCalledWith(failure);
      expect(releaseSlot).toHaveBeenCalledTimes(1);
    });

    it('stops quietly and releases the slot when the client disconnects', async () => {
      await addFile(1, 'one.epub', 'first book');
      const session = await prepareSession([1]);
      const { res } = fakeResponse();
      appSettings.getDownloadPattern.mockImplementationOnce(() => {
        res.emit('close');
        return Promise.resolve('');
      });

      await expect(service.streamPart(session.token, 0, user, res)).resolves.toBeUndefined();

      expect(releaseSlot).toHaveBeenCalledTimes(1);
      expect(res.listenerCount('close')).toBe(0);
    });
  });
});
