import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateExportSessionDto, MAX_EXPORT_SESSION_BOOK_IDS } from './create-export-session.dto';

async function errorsFor(value: Record<string, unknown>) {
  return validate(plainToInstance(CreateExportSessionDto, value), { whitelist: true, forbidNonWhitelisted: true });
}

describe('CreateExportSessionDto', () => {
  it('accepts explicit ids or a query selection with a scope', async () => {
    expect(await errorsFor({ bookIds: [1, 2], scope: 'primary' })).toHaveLength(0);
    expect(await errorsFor({ query: { libraryId: 3 }, scope: 'all', partSizeMb: 500 })).toHaveLength(0);
  });

  it('rejects unknown scopes and part sizes', async () => {
    expect((await errorsFor({ bookIds: [1], scope: 'everything' })).length).toBeGreaterThan(0);
    expect((await errorsFor({ bookIds: [1], scope: 'primary', partSizeMb: 4096 })).length).toBeGreaterThan(0);
    expect((await errorsFor({ bookIds: [1] })).length).toBeGreaterThan(0);
  });

  it('caps the explicit id list', async () => {
    const bookIds = Array.from({ length: MAX_EXPORT_SESSION_BOOK_IDS + 1 }, (_, i) => i + 1);
    expect((await errorsFor({ bookIds, scope: 'primary' })).length).toBeGreaterThan(0);
  });
});
