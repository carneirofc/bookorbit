import { NotFoundException } from '@nestjs/common';

import { BookExportSessionStore, EXPORT_SESSION_TTL_MS, MAX_EXPORT_SESSIONS_PER_USER } from './book-export-session.store';

const input = (userId: number) => ({ userId, scope: 'primary' as const, parts: [[1, 2], [3]], archiveBaseName: 'books' });

describe('BookExportSessionStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a session only to the user who created it', () => {
    const store = new BookExportSessionStore();
    const session = store.create(input(1));

    expect(store.get(session.token, 1).parts).toEqual([[1, 2], [3]]);
    expect(() => store.get(session.token, 2)).toThrow(NotFoundException);
    expect(() => store.get('unknown', 1)).toThrow(NotFoundException);
  });

  it('expires sessions after the TTL', () => {
    vi.useFakeTimers();
    const store = new BookExportSessionStore();
    const session = store.create(input(1));

    vi.advanceTimersByTime(EXPORT_SESSION_TTL_MS - 1);
    expect(store.get(session.token, 1)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(() => store.get(session.token, 1)).toThrow(NotFoundException);
  });

  it('evicts the oldest session when a user exceeds the per-user cap', () => {
    vi.useFakeTimers();
    const store = new BookExportSessionStore();
    const tokens: string[] = [];
    for (let i = 0; i <= MAX_EXPORT_SESSIONS_PER_USER; i++) {
      tokens.push(store.create(input(1)).token);
      vi.advanceTimersByTime(1);
    }
    const other = store.create(input(2));

    expect(() => store.get(tokens[0], 1)).toThrow(NotFoundException);
    for (const token of tokens.slice(1)) expect(store.get(token, 1)).toBeDefined();
    expect(store.get(other.token, 2)).toBeDefined();
  });

  it('tracks overlapping downloads of the same part until each one is released', () => {
    const store = new BookExportSessionStore();
    const session = store.create(input(1));

    const first = store.trackActivePart(session, 1);
    const second = store.trackActivePart(session, 1);
    first();
    first();
    expect([...session.activeParts.keys()]).toEqual([1]);
    second();
    expect(session.activeParts.size).toBe(0);
  });
});
