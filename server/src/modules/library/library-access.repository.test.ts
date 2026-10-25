import { LibraryAccessRepository } from './library-access.repository';

describe('LibraryAccessRepository', () => {
  const db = {
    query: {
      userLibraryAccess: {
        findFirst: vi.fn(),
      },
    },
  };
  let repo: LibraryAccessRepository;

  beforeEach(() => {
    vi.resetAllMocks();
    repo = new LibraryAccessRepository(db as any);
  });

  it('hasUserAccess returns false when no access row exists', async () => {
    db.query.userLibraryAccess.findFirst.mockResolvedValue(undefined);
    await expect(repo.hasUserAccess(1, 2)).resolves.toBe(false);
  });

  it('hasUserAccess returns true when an access row exists', async () => {
    db.query.userLibraryAccess.findFirst.mockResolvedValue({ userId: 1, libraryId: 2, accessLevel: 'viewer' });
    await expect(repo.hasUserAccess(1, 2)).resolves.toBe(true);
  });

  it('findUserAccessLevel returns the stored level or null', async () => {
    db.query.userLibraryAccess.findFirst.mockResolvedValueOnce({ accessLevel: 'editor' }).mockResolvedValueOnce(undefined);
    await expect(repo.findUserAccessLevel(1, 2)).resolves.toBe('editor');
    await expect(repo.findUserAccessLevel(1, 3)).resolves.toBeNull();
  });
});
