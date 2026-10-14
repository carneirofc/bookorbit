import { describe, expect, it } from 'vitest';

import { matchesRecordedFileState } from './file-identity';

describe('matchesRecordedFileState', () => {
  const mtime = new Date('2024-01-01T10:00:00.123Z');

  it('matches when size and mtime are unchanged', () => {
    expect(matchesRecordedFileState({ sizeBytes: 1024, mtime }, { sizeBytes: 1024, mtime: new Date(mtime.getTime()) })).toBe(true);
  });

  it('rejects a different size', () => {
    expect(matchesRecordedFileState({ sizeBytes: 1024, mtime }, { sizeBytes: 2048, mtime })).toBe(false);
  });

  it('rejects a different mtime', () => {
    expect(matchesRecordedFileState({ sizeBytes: 1024, mtime }, { sizeBytes: 1024, mtime: new Date('2026-10-12') })).toBe(false);
  });

  it('rejects when the recorded state is unknown', () => {
    expect(matchesRecordedFileState({ sizeBytes: null, mtime: null }, { sizeBytes: 1024, mtime })).toBe(false);
    expect(matchesRecordedFileState({ sizeBytes: 1024, mtime: null }, { sizeBytes: 1024, mtime })).toBe(false);
  });
});
