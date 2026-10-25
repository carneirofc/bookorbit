import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { APP_FEATURES, type AccessLevel } from '@bookorbit/types';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { libraries, userLibraryAccess, users } from '../../db/schema';

type Db = NodePgDatabase<typeof schema>;

const visibleLibraryCondition = APP_FEATURES.podcasts ? undefined : eq(libraries.type, 'books');

@Injectable()
export class LibraryAccessRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  findAllIds() {
    return this.db.select({ id: libraries.id }).from(libraries).where(visibleLibraryCondition).orderBy(libraries.displayOrder, libraries.name);
  }

  findAccessibleIdsForUser(userId: number, accessLevels?: readonly AccessLevel[]) {
    const accessJoin = and(
      eq(userLibraryAccess.libraryId, libraries.id),
      eq(userLibraryAccess.userId, userId),
      accessLevels ? inArray(userLibraryAccess.accessLevel, [...accessLevels]) : undefined,
    );
    return this.db
      .select({ id: libraries.id })
      .from(libraries)
      .innerJoin(userLibraryAccess, accessJoin)
      .where(visibleLibraryCondition)
      .orderBy(libraries.displayOrder, libraries.name);
  }

  async hasUserAccess(userId: number, libraryId: number): Promise<boolean> {
    const row = await this.db.query.userLibraryAccess.findFirst({
      where: and(eq(userLibraryAccess.userId, userId), eq(userLibraryAccess.libraryId, libraryId)),
    });
    return row !== undefined;
  }

  async findUserAccessLevel(userId: number, libraryId: number): Promise<AccessLevel | null> {
    const row = await this.db.query.userLibraryAccess.findFirst({
      columns: { accessLevel: true },
      where: and(eq(userLibraryAccess.userId, userId), eq(userLibraryAccess.libraryId, libraryId)),
    });
    return row?.accessLevel ?? null;
  }

  findUserIdsWithAccess(libraryId: number, userIds: number[]) {
    return this.db
      .select({ id: users.id })
      .from(users)
      .leftJoin(userLibraryAccess, and(eq(userLibraryAccess.userId, users.id), eq(userLibraryAccess.libraryId, libraryId)))
      .where(and(inArray(users.id, userIds), or(eq(users.isSuperuser, true), isNotNull(userLibraryAccess.userId))));
  }
}
