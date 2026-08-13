import { open } from 'fs/promises';

export type SignatureVerdict = 'match' | 'mismatch' | 'unknown';

/** Enough to reach the PalmDB type/creator pair at offset 60 and skip a large ID3v2 tag header. */
export const SIGNATURE_HEAD_BYTES = 4096;

type SignatureCheck = (head: Buffer) => boolean;

function startsWith(head: Buffer, signature: readonly number[], offset = 0): boolean {
  if (head.length < offset + signature.length) return false;
  return signature.every((byte, index) => head[offset + index] === byte);
}

function asciiAt(head: Buffer, offset: number, text: string): boolean {
  return startsWith(
    head,
    [...text].map((c) => c.charCodeAt(0)),
    offset,
  );
}

const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
] as const;

const RAR_SIGNATURES = [
  [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00],
  [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00],
] as const;

const SEVENZIP_SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] as const;

const PALMDB_TYPES = ['BOOKMOBI', 'TEXtREAd'] as const;

const MP4_BRANDS = ['M4A ', 'M4B ', 'M4V ', 'isom', 'mp41', 'mp42', 'iso2', 'dash'] as const;

const isZip: SignatureCheck = (head) => ZIP_SIGNATURES.some((sig) => startsWith(head, sig));
const isRar: SignatureCheck = (head) => RAR_SIGNATURES.some((sig) => startsWith(head, sig));
const is7z: SignatureCheck = (head) => startsWith(head, SEVENZIP_SIGNATURE);
const isPdf: SignatureCheck = (head) => asciiAt(head, 0, '%PDF-');
const isOgg: SignatureCheck = (head) => asciiAt(head, 0, 'OggS');
const isFlac: SignatureCheck = (head) => asciiAt(head, 0, 'fLaC');

/** PalmDB puts an 8-byte type+creator pair at offset 60; MOBI and the AZW variants share it. */
const isPalmDoc: SignatureCheck = (head) => PALMDB_TYPES.some((type) => asciiAt(head, 60, type));

/** ISO-BMFF: a size-prefixed `ftyp` box at offset 4, followed by the major brand. */
const isMp4Container: SignatureCheck = (head) => asciiAt(head, 4, 'ftyp') && MP4_BRANDS.some((brand) => asciiAt(head, 8, brand));

/**
 * MP3 is either an ID3v2 tag or a bare MPEG frame. A bare frame starts with 11 set
 * sync bits; the following version/layer bits must not be the reserved all-ones
 * pattern, which is how random binary tends to produce a false positive.
 */
const isMp3: SignatureCheck = (head) => {
  if (asciiAt(head, 0, 'ID3')) return true;
  if (head.length < 2) return false;
  if (head[0] !== 0xff) return false;
  if ((head[1] & 0xe0) !== 0xe0) return false;
  return (head[1] & 0x18) !== 0x08 && (head[1] & 0x06) !== 0x00;
};

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

/** FB2 is XML; the root element name is what separates it from any other XML document. */
const isFb2: SignatureCheck = (head) => {
  const body = startsWith(head, UTF8_BOM) ? head.subarray(UTF8_BOM.length) : head;
  const text = body.subarray(0, 1024).toString('latin1').trimStart();
  if (!text.startsWith('<?xml') && !text.startsWith('<FictionBook')) return false;
  return text.includes('FictionBook');
};

const SIGNATURES: Readonly<Record<string, readonly SignatureCheck[]>> = {
  epub: [isZip],
  kepub: [isZip],
  cbz: [isZip],
  cbr: [isRar],
  cb7: [is7z],
  pdf: [isPdf],
  mobi: [isPalmDoc],
  azw: [isPalmDoc],
  azw3: [isPalmDoc],
  ogg: [isOgg],
  opus: [isOgg],
  flac: [isFlac],
  mp3: [isMp3],
  m4a: [isMp4Container],
  m4b: [isMp4Container],
  fb2: [isFb2],
};

/**
 * Compares a file's leading bytes against the format its extension claims.
 *
 * Deliberately three-valued. `unknown` means "no opinion" - either the extension
 * has no entry here or the buffer is too short to judge - and callers must treat
 * it as allowed. A signature table is never complete, and rejecting a legitimate
 * book because its container is unusual is worse than letting an odd file through
 * to the metadata extractor, which will produce a specific error of its own.
 */
export function classifySignature(head: Buffer, ext: string): SignatureVerdict {
  const checks = SIGNATURES[ext.toLowerCase()];
  if (!checks || head.length === 0) return 'unknown';
  return checks.some((check) => check(head)) ? 'match' : 'mismatch';
}

/** Reads just enough of a file to classify it. I/O failures degrade to `unknown`. */
export async function readSignatureHead(absolutePath: string): Promise<Buffer> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(absolutePath, 'r');
    const buf = Buffer.alloc(SIGNATURE_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return Buffer.alloc(0);
  } finally {
    await fh?.close();
  }
}
