import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AccessLevel } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { EDITOR_ACCESS_LEVELS } from './library.constants';
import { LibraryAccessRepository } from './library-access.repository';

/**
 * Who is asking. A full `RequestUser` satisfies it; background jobs that only know a user id and the
 * superuser flag (achievement evaluation, for instance) build one without a `sessionId`.
 */
export type LibraryAccessSubject = Pick<RequestUser, 'id' | 'isSuperuser' | 'sessionId'>;

const ACCESS_RANK: Record<AccessLevel, number> = { viewer: 1, editor: 2, owner: 3 };

/**
 * The single source of truth for "which libraries may this user read". Every listing, aggregate,
 * statistic and per-library check derives its scope from here, so a rule added to this service
 * (for example locked libraries) reaches every surface at once.
 *
 * Code outside the library module must not query `user_library_access` itself; the architecture
 * test in `architecture-boundaries.test.ts` freezes the remaining direct readers to an allowlist.
 *
 * This lives in its own leaf module because `LibraryModule` imports `AchievementModule`, so modules
 * that `LibraryModule` depends on can still import `LibraryAccessModule`. `LibraryService` exposes
 * the same methods by delegating here.
 */
@Injectable()
export class LibraryAccessService {
  constructor(private readonly repo: LibraryAccessRepository) {}

  /** Ids of every library the user may read, in display order. Superusers get every visible library. */
  async findAccessibleLibraryIds(user: LibraryAccessSubject): Promise<number[]> {
    const ids = user.isSuperuser ? await this.repo.findAllIds() : await this.repo.findAccessibleIdsForUser(user.id);
    return ids.map(({ id }) => id);
  }

  /** Ids of every library the user may edit (editor or owner). Superusers get every visible library. */
  async findEditableLibraryIds(user: LibraryAccessSubject): Promise<number[]> {
    const ids = user.isSuperuser ? await this.repo.findAllIds() : await this.repo.findAccessibleIdsForUser(user.id, EDITOR_ACCESS_LEVELS);
    return ids.map(({ id }) => id);
  }

  /**
   * The library ids a book query may read: every accessible library, or only `libraryId` when given.
   * Returns an empty list when `libraryId` is not accessible, so callers that must reject that case
   * check `libraryId !== undefined && scope.length === 0`.
   */
  async resolveBookScope(user: LibraryAccessSubject, libraryId?: number): Promise<number[]> {
    const accessible = await this.findAccessibleLibraryIds(user);
    if (libraryId === undefined) return accessible;
    return accessible.includes(libraryId) ? [libraryId] : [];
  }

  async verifyUserAccess(user: LibraryAccessSubject, libraryId: number): Promise<void> {
    if (user.isSuperuser) return;
    const hasAccess = await this.repo.hasUserAccess(user.id, libraryId);
    if (!hasAccess) throw new ForbiddenException('No access to this library');
  }

  async verifyUserAccessLevel(user: LibraryAccessSubject, libraryId: number, required: AccessLevel): Promise<void> {
    if (user.isSuperuser) return;
    const accessLevel = await this.repo.findUserAccessLevel(user.id, libraryId);
    if (!accessLevel) throw new ForbiddenException('No access to this library');
    if (ACCESS_RANK[accessLevel] < ACCESS_RANK[required]) throw new ForbiddenException('Insufficient library access level');
  }

  /**
   * Which of these users can open this library. Callers that hold user ids rather than whole
   * users - a notifier resolving one link per recipient, for instance - use this instead of
   * `verifyUserAccess`.
   */
  async findUserIdsWithAccess(libraryId: number, userIds: number[]): Promise<Set<number>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.repo.findUserIdsWithAccess(libraryId, userIds);
    return new Set(rows.map(({ id }) => id));
  }
}
