import { Test } from '@nestjs/testing';

import { LIBRARY_ACCESS_KEY } from '../../common/decorators/require-library-access.decorator';
import { LIBRARY_TYPE_KEY } from '../../common/decorators/require-library-type.decorator';
import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { makeUser } from '../../common/test-utils/make-user';
import { BookDiscoverController } from './book-discover.controller';
import { BookDiscoverFacetsService } from './book-discover-facets.service';

describe('BookDiscoverController', () => {
  it('passes the library, request and user to the service', async () => {
    const response = { total: 1, libraryTotal: 2, facets: {} };
    const service = { facetsForLibrary: vi.fn().mockResolvedValue(response) };
    const moduleRef = await Test.createTestingModule({
      controllers: [BookDiscoverController],
      providers: [{ provide: BookDiscoverFacetsService, useValue: service }],
    }).compile();
    const user = makeUser();
    const request = { selection: {}, facets: [{ key: 'tag' as const }] };

    await expect(moduleRef.get(BookDiscoverController).getDiscoverFacets(4, request, user)).resolves.toBe(response);
    expect(service.facetsForLibrary).toHaveBeenCalledWith(user, 4, request);
  });

  it('requires viewer access to a books library and no permission', () => {
    const handler = BookDiscoverController.prototype.getDiscoverFacets;
    expect(Reflect.getMetadata(LIBRARY_ACCESS_KEY, handler)).toBe('viewer');
    expect(Reflect.getMetadata(LIBRARY_TYPE_KEY, handler)).toBe('books');
    expect(Reflect.getMetadata(PERMISSION_KEY, handler)).toBeUndefined();
  });
});
