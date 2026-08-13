import { Injectable, Logger, PayloadTooLargeException } from '@nestjs/common';
import { copyFile, mkdir, rename, stat, unlink } from 'fs/promises';
import { createWriteStream } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { createHash, randomUUID } from 'crypto';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';

import { SIGNATURE_HEAD_BYTES } from '../../common/file-signature';
import { AppSettingsService } from '../app-settings/app-settings.service';

// Hard ceiling applied at the multipart level. The service enforces a lower configurable limit.
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB

export interface StoredUpload {
  tempPath: string;
  sizeBytes: number;
  sha256: string;
  /** First `SIGNATURE_HEAD_BYTES` of the file, for magic-byte validation. */
  head: Buffer;
}

@Injectable()
export class UploadStorageService {
  private readonly logger = new Logger(UploadStorageService.name);

  constructor(private readonly appSettings: AppSettingsService) {}

  /**
   * Streams the multipart file to a temp path on disk, hashing it and capturing its
   * leading bytes on the way through so no caller has to read the file back.
   *
   * `targetDir` should be on the same filesystem as the eventual destination -
   * `moveToPath` can then rename instead of copying. It defaults to the OS temp
   * dir, which in a container is usually a different device.
   */
  async streamToTemp(source: Readable, targetDir?: string): Promise<StoredUpload> {
    const dir = targetDir ?? tmpdir();
    await mkdir(dir, { recursive: true });

    const tempPath = join(dir, `bookorbit-upload-${randomUUID()}`);
    const hash = createHash('sha256');
    const headChunks: Buffer[] = [];
    let headBytes = 0;

    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        if (headBytes < SIGNATURE_HEAD_BYTES) {
          const slice = chunk.subarray(0, SIGNATURE_HEAD_BYTES - headBytes);
          headChunks.push(Buffer.from(slice));
          headBytes += slice.length;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(source, meter, createWriteStream(tempPath));
    } catch (err) {
      await this.cleanup(tempPath);
      throw err;
    }

    if ((source as Readable & { truncated?: boolean }).truncated) {
      await this.cleanup(tempPath);
      const limitMb = await this.appSettings.getMaxUploadSizeMb();
      throw new PayloadTooLargeException(`File exceeds the ${limitMb} MB upload limit`);
    }

    const { size } = await stat(tempPath);
    return { tempPath, sizeBytes: size, sha256: hash.digest('hex'), head: Buffer.concat(headChunks) };
  }

  /**
   * Moves the temp file to an already-resolved absolute destination path.
   * Creates parent directories as needed.
   * Uses rename() and falls back to copy+unlink for cross-device moves.
   */
  async moveToPath(tempPath: string, absolutePath: string): Promise<void> {
    await mkdir(dirname(absolutePath), { recursive: true });

    try {
      await rename(tempPath, absolutePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        await copyFile(tempPath, absolutePath);
        await this.cleanup(tempPath);
      } else {
        throw err;
      }
    }
  }

  async cleanup(tempPath: string): Promise<void> {
    await unlink(tempPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') {
        const errorClass = err.name ?? 'Error';
        const errorMessage = sanitizeLogValue(err.message);
        this.logger.warn(`[upload.storage_cleanup] [fail] path="${tempPath}" errorClass=${errorClass} error="${errorMessage}" - file cleanup failed`);
      }
    });
  }
}
