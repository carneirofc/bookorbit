import { Body, Controller, Post } from '@nestjs/common';

import type { TagFacetsResponse } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { BookTagFacetsService } from './book-tag-facets.service';
import { TagFacetsQueryPipe, type ParsedTagFacetsQuery } from './pipes/book-query.pipe';

@Controller('books/tag-facets')
export class BookTagFacetsController {
  constructor(private readonly tagFacetsService: BookTagFacetsService) {}

  @Post()
  getTagFacets(@Body(TagFacetsQueryPipe) query: ParsedTagFacetsQuery, @CurrentUser() user: RequestUser): Promise<TagFacetsResponse> {
    return this.tagFacetsService.getTagFacets(user, query);
  }
}
