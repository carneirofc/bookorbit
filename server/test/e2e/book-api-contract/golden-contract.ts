import { expect } from 'vitest';

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_HEX = /\b[0-9a-f]{32,128}\b/gi;

const HASH_KEY = /(requestid|hash|checksum|etag|token|sha\d*|md5)$/i;
const COVER_VOLATILE_KEY = /^(cover|thumbnail).*(version|updatedat|token|hash)$/i;
const DURATION_MS_KEY = /^(duration|elapsed).*ms$/i;
const ID_KEY = /^(id|.+Id)$/;
const ID_LIST_KEY = /^(ids|.+Ids)$/;

export const ADDITIVE_LIBRARY_KEYS = {
  isProtected: false,
  isLocked: false,
  unlockExpiresAt: null,
} as const;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Removes exactly the keys a later feature may add to a library object, and only when they carry
 * their unprotected values. Any other value for those keys fails the contract.
 */
export function stripAdditiveLibraryKeys<T extends JsonObject>(library: T): JsonObject {
  const stripped: JsonObject = { ...library };
  for (const [key, expected] of Object.entries(ADDITIVE_LIBRARY_KEYS)) {
    if (!(key in stripped)) continue;
    expect(stripped[key], `library.${key} must stay at its unprotected value`).toBe(expected);
    delete stripped[key];
  }
  return stripped;
}

/**
 * Every key and value of `before` must be unchanged in `after`. `after` may only add the
 * additive protection keys, and only with their unprotected values.
 */
export function expectSameLibraryContract(before: JsonObject, after: JsonObject): void {
  for (const key of Object.keys(before)) {
    expect(after, `library key "${key}" must still exist`).toHaveProperty(key);
    expect(after[key], `library key "${key}" must keep its value`).toEqual(before[key]);
  }
  const added = Object.keys(after).filter((key) => !(key in before));
  for (const key of added) {
    expect(Object.keys(ADDITIVE_LIBRARY_KEYS), `unexpected new library key "${key}"`).toContain(key);
    expect(after[key], `library.${key} must stay at its unprotected value`).toBe(ADDITIVE_LIBRARY_KEYS[key as keyof typeof ADDITIVE_LIBRARY_KEYS]);
  }
}

export interface GoldenNormalizerOptions {
  /** Absolute directories whose prefix is replaced by a stable label. */
  roots: Record<string, string>;
}

/**
 * Replaces volatile values with stable placeholders while keeping every key. Database ids map to
 * `<id:N>` in order of first appearance across everything this instance has normalized.
 */
export class GoldenNormalizer {
  private readonly ids = new Map<number, number>();
  private readonly uuids = new Map<string, number>();
  private readonly roots: [string, string][];

  constructor(options: GoldenNormalizerOptions) {
    this.roots = Object.entries(options.roots)
      .map(([label, path]): [string, string] => [label, path.replace(/\/+$/, '')])
      .sort((a, b) => b[1].length - a[1].length);
  }

  normalize(value: unknown, key?: string): unknown {
    if (Array.isArray(value)) {
      const isIdList = key !== undefined && ID_LIST_KEY.test(key);
      return value.map((item) => (isIdList && typeof item === 'number' ? this.idPlaceholder(item) : this.normalize(item, key)));
    }
    if (isObject(value)) {
      const result: JsonObject = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        result[childKey] = this.normalize(childValue, childKey);
      }
      return result;
    }
    if (key !== undefined && typeof value === 'number') {
      if (ID_KEY.test(key)) return this.idPlaceholder(value);
      if (DURATION_MS_KEY.test(key)) return '<durationMs>';
    }
    if (typeof value === 'string' && value.length > 0) {
      if (key !== undefined && (HASH_KEY.test(key) || COVER_VOLATILE_KEY.test(key))) return '<volatile>';
      return this.normalizeString(value);
    }
    return value;
  }

  private idPlaceholder(id: number): string {
    let index = this.ids.get(id);
    if (index === undefined) {
      index = this.ids.size + 1;
      this.ids.set(id, index);
    }
    return `<id:${index}>`;
  }

  private normalizeString(raw: string): string {
    let result = raw;
    for (const [label, path] of this.roots) {
      result = result.split(path).join(`<${label}>`);
    }
    result = result.replace(UUID, (match) => {
      const lower = match.toLowerCase();
      let index = this.uuids.get(lower);
      if (index === undefined) {
        index = this.uuids.size + 1;
        this.uuids.set(lower, index);
      }
      return `<uuid:${index}>`;
    });
    result = result.replace(ISO_TIMESTAMP, '<timestamp>');
    result = result.replace(LONG_HEX, '<hash>');
    return result;
  }
}

export interface RecordedResponse {
  statusCode: number;
  contentType: string | null;
  body: unknown;
}

interface InjectLike {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}

export function parseSseEvents(body: string): unknown[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as unknown);
}

export function recordResponse(response: InjectLike, options: { sse?: boolean } = {}): RecordedResponse {
  const contentTypeHeader = response.headers['content-type'];
  const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader.toLowerCase().replace(/;\s*charset=utf-8/, '; charset=utf-8') : null;
  let body: unknown = null;
  if (options.sse) {
    body = parseSseEvents(response.body);
  } else if (response.body.length > 0) {
    try {
      body = JSON.parse(response.body) as unknown;
    } catch {
      body = response.body;
    }
  }
  return { statusCode: response.statusCode, contentType, body };
}
