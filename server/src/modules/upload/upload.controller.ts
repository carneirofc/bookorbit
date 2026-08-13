import { CHUNK_UPLOAD_HEADER, MAX_CHUNK_BYTES, Permission } from '@bookorbit/types';
import type { ChunkUploadProgressResponse } from '@bookorbit/types';
import { BadRequestException, Controller, Delete, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { MultipartRequest } from '../../common/types/multipart-request';
import type { RequestUser } from '../../common/types/request-user';
import { AppSettingsService } from '../app-settings/app-settings.service';
import { UploadService } from './upload.service';
import { UploadSessionService } from './upload-session.service';
import { parseChunkUploadFields } from './upload-chunk.fields';

@Controller('libraries')
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly uploadSessions: UploadSessionService,
    private readonly appSettings: AppSettingsService,
  ) {}

  @Post(':id/upload')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(Permission.LibraryUpload)
  async uploadBook(
    @Param('id', ParseIntPipe) libraryId: number,
    @Query('folderId') rawFolderId: string | undefined,
    @CurrentUser() user: RequestUser,
    @Req() req: MultipartRequest,
  ) {
    // Override the global multipart fileSize limit for book uploads.
    // Per-request options are deep-merged with plugin defaults (busboy config),
    // so this fileSize takes precedence over the global 20 MB cover limit.
    // A chunk request is capped at a chunk instead, since the limit has to be chosen
    // before the body is parsed and so cannot depend on the form fields.
    const limitMb = await this.appSettings.getMaxUploadSizeMb();
    const isChunk = typeof req.headers[CHUNK_UPLOAD_HEADER] === 'string';
    const data = await req.file({
      limits: { fileSize: isChunk ? MAX_CHUNK_BYTES : limitMb * 1024 * 1024, files: 1, fields: 12, fieldSize: 1024, parts: 20 },
    });
    if (!data) throw new BadRequestException('No file provided');

    const folderId = this.parseFolderId(rawFolderId);
    const chunk = parseChunkUploadFields(data.fields);

    if (chunk) {
      // Re-checked on every chunk: without this a caller with no access to the library
      // could still spend the server's disk assembling a file it can never store.
      await this.uploadService.prepareUpload(libraryId, folderId, chunk.fileName ?? data.filename, user);

      const result = await this.uploadSessions.writeChunk({
        uploadId: chunk.uploadId,
        userId: user.id,
        rawFileName: chunk.fileName ?? data.filename,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunk.totalChunks,
        chunkSize: chunk.chunkSize,
        totalSize: chunk.totalSize,
        chunkSha256: chunk.chunkSha256,
        chunkStream: data.file,
        maxTotalBytes: limitMb * 1024 * 1024,
      });

      if (result.status === 'partial') {
        const progress: ChunkUploadProgressResponse = {
          chunked: true,
          complete: false,
          receivedChunks: result.receivedChunks,
          totalChunks: result.totalChunks,
          finalizing: result.finalizing,
        };
        return progress;
      }

      try {
        return await this.uploadService.uploadAssembled(libraryId, folderId, result.assembled, user);
      } finally {
        await result.assembled.release();
      }
    }

    return this.uploadService.upload(libraryId, folderId, data.filename, data.file, user);
  }

  @Delete(':id/upload/:uploadId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.LibraryUpload)
  cancelUpload(@CurrentUser() user: RequestUser, @Param('uploadId') uploadId: string) {
    return this.uploadSessions.abort(uploadId, user.id);
  }

  private parseFolderId(rawFolderId: string | undefined): number | undefined {
    if (rawFolderId === undefined) return undefined;

    const value = rawFolderId.trim();
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException('Invalid folderId');
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new BadRequestException('Invalid folderId');
    }

    return parsed;
  }
}
