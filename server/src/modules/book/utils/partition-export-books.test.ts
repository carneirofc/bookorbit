import { partitionBooksBySize } from './partition-export-books';

const book = (bookId: number, bytes: number, fileCount = 1) => ({ bookId, bytes, fileCount });

describe('partitionBooksBySize', () => {
  it('packs books greedily in order without exceeding the byte limit', () => {
    const parts = partitionBooksBySize([book(1, 40), book(2, 40), book(3, 40), book(4, 10)], 100, 100);
    expect(parts.map((p) => p.bookIds)).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(parts.map((p) => p.bytes)).toEqual([80, 50]);
    expect(parts.every((p) => !p.oversized)).toBe(true);
  });

  it('gives a book larger than the limit its own oversized part', () => {
    const parts = partitionBooksBySize([book(1, 10), book(2, 500), book(3, 10)], 100, 100);
    expect(parts.map((p) => p.bookIds)).toEqual([[1], [2], [3]]);
    expect(parts.map((p) => p.oversized)).toEqual([false, true, false]);
  });

  it('starts a new part when the file limit would be exceeded', () => {
    const parts = partitionBooksBySize([book(1, 1, 3), book(2, 1, 3), book(3, 1, 1)], 1000, 4);
    expect(parts.map((p) => p.bookIds)).toEqual([[1], [2, 3]]);
    expect(parts.map((p) => p.fileCount)).toEqual([3, 4]);
  });

  it('fills a part up to exactly the limit without flagging it oversized', () => {
    const parts = partitionBooksBySize([book(1, 60), book(2, 40), book(3, 100), book(4, 1)], 100, 100);
    expect(parts.map((p) => p.bookIds)).toEqual([[1, 2], [3], [4]]);
    expect(parts.every((p) => !p.oversized)).toBe(true);
  });

  it('returns no parts for an empty selection', () => {
    expect(partitionBooksBySize([], 100, 100)).toEqual([]);
  });
});
