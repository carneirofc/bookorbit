# Investigation: a book entry opens another book's EPUB

Branch: `investigate/epub-cross-link-mixup` (cut from `BO-1719-replace-book-file` at `83728c08`).

## Report

A user opened a book in the library and the EPUB served for it was a different book's file. No titles, IDs or repro steps were given.

## Status

- A concrete root cause that reproduces this symptom was found in code and fixed (`fix(scanner): stop inode reuse from handing a book another file`). It needs no concurrency or unusual setup, so it is the most likely explanation.
- A second, narrower cause in today's replace-file feature was found and fixed (`fix(books): resolve the replaced file's path under the book lock`).
- **Neither has been confirmed against the user's data.** The investigation had no access to the user's database or library folder, so this is a code-level diagnosis. See "Ask" below.

## Root cause 1 (fixed): inode reuse during move detection

Move detection treated "same inode number" as proof that a file had been renamed:

- File watcher: `FileEventProcessorService.detectMovedFile` (`server/src/modules/scanner/file-event-processor.service.ts`).
- Full scan: `tryReuseMovedBookInLibrary`, `tryTransferMissingBook`, `resolveByLocalIno`, `resolveByGlobalIno` (`server/src/modules/scanner/scanner.service.ts`).

When the last content file of a book is deleted, the watcher deliberately keeps its `book_files` row and marks the book `missing`, so a rename can be detected later. Filesystems such as ext4 hand freed inode numbers to newly created files. The next unrelated file written into the library (a download, a Book Dock finalize, an upload) can receive the deleted file's inode. Move detection then:

1. finds the deleted book's row by inode,
2. sees the old path no longer exists, so it accepts the match,
3. re-points that row (and, for the scan paths, the book's `folderPath` or library) at the new file and marks the book present.

The old entry (title, cover, progress, annotations) now serves the other book's file. The watcher path also keeps the old `file_hash`, which is the fingerprint used below.

**Fix:** an inode match now counts only when the recorded `size_bytes` and `mtime` also match, both of which a rename preserves (`server/src/modules/scanner/lib/file-identity.ts`). The one exception is a file that stays within the same book, which cannot cross books. Regression tests cover the watcher, in-library reuse and cross-library transfer.

## Root cause 2 (fixed): replace-file read the path before taking the lock

`BookFileReplaceService.replaceFile` read `book_files.absolute_path` before streaming the upload, and only took `bookOperationLockKey(bookId)` afterwards. If a rename or move of that book finished during the upload, and another book's file then took the old path, the swap replaced that other book's file. The original was then deleted as the "backup", while the replaced row recorded the new hash. The target is now re-read once the book lock is held.

This feature only landed on 2026-10-12, so it cannot explain reports from instances that don't run it.

## Ruled out

- **Serving and caching.** `/api/v1/epub/:bookId/...` resolves `fileId` (checked against `bookId`) or `books.primary_file_id` to `book_files.absolute_path` on every request. The parsed-EPUB cache is keyed by absolute path and revalidated by mtime. The client keeps no cached book content, and the service worker caches only the app shell, covers and thumbnails. A wrong file is served only if the DB row points at the wrong path or the bytes at that path changed.
- **Two rows sharing one path.** `book_files_absolute_path_uidx` is a unique index.
- **Metadata-provider matching (Google Books, Hardcover, Amazon and so on).** `computeConfidence()` only scores candidates for auto-finalize. Book Dock never attaches a file to an existing book by title, author or ISBN similarity. Finalize joins an existing book only by exact `(library_id, folder_path)`.
- **Book Dock and move batch loops.** Results are keyed by dock file id and absolute path, not by array index.
- **Scanner prefix matching.** Folder `startsWith` checks append a path separator.

## Not fixed: narrower risks worth a follow-up

All of these need concurrent writers or a destination name collision:

- **Silent overwrite on rename.** `UploadStorageService.moveToPath` uses `rename()`, which silently replaces an existing destination on POSIX, so its `EEXIST` branch never fires for files. Book Dock finalize checks the destination with `fsAccess` and then renames, with no lock shared with uploads, request imports or book moves. Two writers resolving to the same path can overwrite each other. `book-move.utils.ts` `moveFile` has the same check-then-rename gap.
- **Stale-row join.** If a `book_files` row exists for a path whose file is missing on disk, finalize treats the path as free. `upsertBookFile` then uses `onConflictDoUpdate` on `absolute_path` to re-point that row at the new file. Whether this is a bug or intended re-acquisition of a missing book is a product decision. In practice the colliding name usually means the same title and author.
- **Book Dock upload naming.** `resolveUniquePath` is check-then-use, so two concurrent uploads with the same filename can collide.

## Ask

To confirm which cause hit this user, send the affected book's ID (from the book's URL) or its title, and the output of the query below. Run it on the BookOrbit Postgres:

```sql
SELECT b.id AS book_id, b.status, b.folder_path, b.primary_file_id,
       bf.id AS file_id, bf.absolute_path, bf.ino, bf.size_bytes, bf.mtime, bf.file_hash, bf.updated_at
FROM books b
JOIN book_files bf ON bf.book_id = b.id
WHERE b.id = <BOOK_ID>;
```

Also send any server log lines containing `[scanner.file_event.move]` or `bookId=<BOOK_ID>`.

**Signature of root cause 1:** `folder_path` or `absolute_path` names a different book than the entry's title. A `[scanner.file_event.move]` log line shows that book "moving" from its old path to the unrelated one. And `file_hash` does not match the file on disk (KOReader partial MD5, the same algorithm as `server/src/modules/scanner/lib/hash.ts`).

## Repair for already affected rows

The fix prevents new cross-links but does not repair existing ones. For an affected book:

1. move the wrongly attached file's row back, or delete the book and let a scan import the file as its own book;
2. restore the original book's file from backup, if it still exists.

Tell us the IDs and a targeted repair can be written.
