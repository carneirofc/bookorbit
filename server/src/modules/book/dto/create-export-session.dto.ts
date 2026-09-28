import { ArrayMaxSize, IsIn, IsOptional } from 'class-validator';

import { BOOK_EXPORT_PART_SIZES_MB, type BookExportPartSizeMb, type BookExportScope } from '@bookorbit/types';
import { BulkSelectionDto } from '../../../common/dto/bulk-selection.dto';

export const MAX_EXPORT_SESSION_BOOK_IDS = 100_000;

export class CreateExportSessionDto extends BulkSelectionDto {
  @ArrayMaxSize(MAX_EXPORT_SESSION_BOOK_IDS)
  declare bookIds?: number[];

  @IsIn(['primary', 'all', 'audio'])
  scope: BookExportScope;

  @IsOptional()
  @IsIn([...BOOK_EXPORT_PART_SIZES_MB])
  partSizeMb?: BookExportPartSizeMb;
}
