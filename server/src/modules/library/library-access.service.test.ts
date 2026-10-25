import { ForbiddenException } from '@nestjs/common';

import { LibraryAccessService } from './library-access.service';

describe('LibraryAccessService', () => {
  const repo = {
    findAllIds: vi.fn(),
    findAccessibleIdsForUser: vi.fn(),
    hasUserAccess: vi.fn(),
    findUserAccessLevel: vi.fn(),
    findUserIdsWithAccess: vi.fn(),
  };
  const superuser = { id: 1, isSuperuser: true };
  const member = { id: 42, isSuperuser: false };
  let service: LibraryAccessService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new LibraryAccessService(repo as any);
    repo.findAllIds.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    repo.findAccessibleIdsForUser.mockResolvedValue([{ id: 2 }, { id: 3 }]);
  });

  describe('findAccessibleLibraryIds', () => {
    it('returns every visible library for superusers without reading grants', async () => {
      await expect(service.findAccessibleLibraryIds(superuser)).resolves.toEqual([1, 2, 3]);
      expect(repo.findAccessibleIdsForUser).not.toHaveBeenCalled();
    });

    it('returns only granted libraries for other users', async () => {
      await expect(service.findAccessibleLibraryIds(member)).resolves.toEqual([2, 3]);
      expect(repo.findAccessibleIdsForUser).toHaveBeenCalledWith(42);
      expect(repo.findAllIds).not.toHaveBeenCalled();
    });
  });

  it('findEditableLibraryIds asks for editor and owner grants only', async () => {
    repo.findAccessibleIdsForUser.mockResolvedValue([{ id: 3 }]);
    await expect(service.findEditableLibraryIds(member)).resolves.toEqual([3]);
    expect(repo.findAccessibleIdsForUser).toHaveBeenCalledWith(42, ['editor', 'owner']);
    await expect(service.findEditableLibraryIds(superuser)).resolves.toEqual([1, 2, 3]);
  });

  describe('resolveBookScope', () => {
    it('returns every accessible library when no library is requested', async () => {
      await expect(service.resolveBookScope(member)).resolves.toEqual([2, 3]);
    });

    it('narrows to the requested library when it is accessible', async () => {
      await expect(service.resolveBookScope(member, 3)).resolves.toEqual([3]);
    });

    it('returns an empty scope when the requested library is not accessible', async () => {
      await expect(service.resolveBookScope(member, 1)).resolves.toEqual([]);
    });

    it('does not trust a requested id a superuser cannot see', async () => {
      await expect(service.resolveBookScope(superuser, 99)).resolves.toEqual([]);
    });
  });

  describe('verifyUserAccess', () => {
    it('skips the lookup for superusers', async () => {
      await expect(service.verifyUserAccess(superuser, 5)).resolves.toBeUndefined();
      expect(repo.hasUserAccess).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException without a grant', async () => {
      repo.hasUserAccess.mockResolvedValue(false);
      await expect(service.verifyUserAccess(member, 5)).rejects.toThrow(new ForbiddenException('No access to this library'));
      expect(repo.hasUserAccess).toHaveBeenCalledWith(42, 5);
    });

    it('passes with a grant', async () => {
      repo.hasUserAccess.mockResolvedValue(true);
      await expect(service.verifyUserAccess(member, 5)).resolves.toBeUndefined();
    });
  });

  describe('verifyUserAccessLevel', () => {
    it('ranks viewer below editor below owner', async () => {
      repo.findUserAccessLevel.mockResolvedValue('editor');
      await expect(service.verifyUserAccessLevel(member, 5, 'viewer')).resolves.toBeUndefined();
      await expect(service.verifyUserAccessLevel(member, 5, 'editor')).resolves.toBeUndefined();
      await expect(service.verifyUserAccessLevel(member, 5, 'owner')).rejects.toThrow('Insufficient library access level');
    });

    it('throws the no-access error when there is no grant at all', async () => {
      repo.findUserAccessLevel.mockResolvedValue(null);
      await expect(service.verifyUserAccessLevel(member, 5, 'viewer')).rejects.toThrow('No access to this library');
    });

    it('skips the lookup for superusers', async () => {
      await expect(service.verifyUserAccessLevel(superuser, 5, 'owner')).resolves.toBeUndefined();
      expect(repo.findUserAccessLevel).not.toHaveBeenCalled();
    });
  });

  it('findUserIdsWithAccess issues no query for an empty user list', async () => {
    await expect(service.findUserIdsWithAccess(5, [])).resolves.toEqual(new Set());
    expect(repo.findUserIdsWithAccess).not.toHaveBeenCalled();
    repo.findUserIdsWithAccess.mockResolvedValue([{ id: 7 }, { id: 9 }]);
    await expect(service.findUserIdsWithAccess(5, [7, 8, 9])).resolves.toEqual(new Set([7, 9]));
  });
});
