import { Body, Controller, Param, ParseIntPipe, Post } from '@nestjs/common';

import type { DiscoverFacetsRequest, DiscoverFacetsResponse } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireLibraryAccess } from '../../common/decorators/require-library-access.decorator';
import { RequireLibraryType } from '../../common/decorators/require-library-type.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { BookDiscoverFacetsService } from './book-discover-facets.service';
import { DiscoverFacetsRequestPipe } from './pipes/discover-facets.pipe';

/** Discover facet counts. The results grid stays on `POST /libraries/:id/books` with the compiled filter. */
@Controller('libraries')
export class BookDiscoverController {
  constructor(private readonly discoverFacetsService: BookDiscoverFacetsService) {}

  @Post(':id/discover/facets')
  @RequireLibraryAccess('viewer')
  @RequireLibraryType('books')
  getDiscoverFacets(
    @Param('id', ParseIntPipe) libraryId: number,
    @Body(DiscoverFacetsRequestPipe) request: DiscoverFacetsRequest,
    @CurrentUser() user: RequestUser,
  ): Promise<DiscoverFacetsResponse> {
    return this.discoverFacetsService.facetsForLibrary(user, libraryId, request);
  }
}
