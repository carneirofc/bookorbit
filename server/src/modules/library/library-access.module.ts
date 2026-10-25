import { Module } from '@nestjs/common';

import { LibraryAccessRepository } from './library-access.repository';
import { LibraryAccessService } from './library-access.service';

@Module({
  providers: [LibraryAccessService, LibraryAccessRepository],
  exports: [LibraryAccessService],
})
export class LibraryAccessModule {}
