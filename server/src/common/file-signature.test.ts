import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { classifySignature, readSignatureHead, SIGNATURE_HEAD_BYTES } from './file-signature';

function head(...parts: (string | number[])[]): Buffer {
  return Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part))));
}

/** Pads to `offset` with zeroes, then writes `text`, so PalmDB fields land where they belong. */
function headAt(offset: number, text: string, totalLength = offset + text.length): Buffer {
  const buf = Buffer.alloc(totalLength);
  buf.write(text, offset, 'latin1');
  return buf;
}

describe('classifySignature', () => {
  const matching: [string, Buffer][] = [
    ['epub', head([0x50, 0x4b, 0x03, 0x04])],
    ['kepub', head([0x50, 0x4b, 0x03, 0x04])],
    ['cbz', head([0x50, 0x4b, 0x05, 0x06])],
    ['cbr', head([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])],
    ['cb7', head([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])],
    ['pdf', head('%PDF-1.7')],
    ['mobi', headAt(60, 'BOOKMOBI')],
    ['azw3', headAt(60, 'BOOKMOBI')],
    ['azw', headAt(60, 'TEXtREAd')],
    ['ogg', head('OggS')],
    ['opus', head('OggS')],
    ['flac', head('fLaC')],
    ['mp3', head('ID3\x04\x00')],
    ['m4b', head([0x00, 0x00, 0x00, 0x20], 'ftypM4B ')],
    ['m4a', head([0x00, 0x00, 0x00, 0x20], 'ftypM4A ')],
    ['fb2', head('<?xml version="1.0"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">')],
  ];

  it.each(matching)('accepts a well-formed .%s', (ext, buf) => {
    expect(classifySignature(buf, ext)).toBe('match');
  });

  it('accepts a bare MPEG frame as mp3', () => {
    expect(classifySignature(head([0xff, 0xfb, 0x90, 0x00]), 'mp3')).toBe('match');
  });

  it('accepts a UTF-8 BOM before the fb2 declaration', () => {
    expect(classifySignature(head([0xef, 0xbb, 0xbf], '<?xml version="1.0"?><FictionBook>'), 'fb2')).toBe('match');
  });

  it('is case insensitive on the extension', () => {
    expect(classifySignature(head('%PDF-1.4'), 'PDF')).toBe('match');
  });

  const mismatching: [string, string, Buffer][] = [
    ['a PDF renamed to .epub', 'epub', head('%PDF-1.7')],
    ['a ZIP renamed to .pdf', 'pdf', head([0x50, 0x4b, 0x03, 0x04])],
    ['a ZIP renamed to .cbr', 'cbr', head([0x50, 0x4b, 0x03, 0x04])],
    ['a RAR renamed to .cbz', 'cbz', head([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])],
    ['plain text renamed to .mobi', 'mobi', headAt(60, 'not a palm database')],
    ['a ZIP renamed to .flac', 'flac', head([0x50, 0x4b, 0x03, 0x04])],
  ];

  it.each(mismatching)('rejects %s', (_label, ext, buf) => {
    expect(classifySignature(buf, ext)).toBe('mismatch');
  });

  it('rejects an mp4 container whose brand is not audio or video', () => {
    expect(classifySignature(head([0x00, 0x00, 0x00, 0x20], 'ftypheic'), 'm4b')).toBe('mismatch');
  });

  describe('unknown', () => {
    it('has no opinion on an extension it does not know', () => {
      expect(classifySignature(head('anything at all'), 'txt')).toBe('unknown');
    });

    it('has no opinion on an empty head', () => {
      expect(classifySignature(Buffer.alloc(0), 'epub')).toBe('unknown');
    });

    it('does not throw on a buffer shorter than the signature it checks', () => {
      expect(classifySignature(head([0x50]), 'epub')).toBe('mismatch');
      expect(classifySignature(head([0x00, 0x00]), 'mobi')).toBe('mismatch');
      expect(classifySignature(head([0xff]), 'mp3')).toBe('mismatch');
    });
  });
});

describe('readSignatureHead', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bookorbit-signature-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads only the leading bytes of a larger file', async () => {
    const path = join(dir, 'big.epub');
    await writeFile(path, Buffer.concat([head([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(SIGNATURE_HEAD_BYTES * 3)]));

    const result = await readSignatureHead(path);

    expect(result.length).toBe(SIGNATURE_HEAD_BYTES);
    expect(classifySignature(result, 'epub')).toBe('match');
  });

  it('returns a short buffer for a file smaller than the head size', async () => {
    const path = join(dir, 'small.pdf');
    await writeFile(path, '%PDF-1.4');

    const result = await readSignatureHead(path);

    expect(result.length).toBe(8);
  });

  it('degrades to an empty buffer when the file cannot be read', async () => {
    const result = await readSignatureHead(join(dir, 'does-not-exist.epub'));

    expect(result.length).toBe(0);
    expect(classifySignature(result, 'epub')).toBe('unknown');
  });
});
