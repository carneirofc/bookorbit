import { execFile } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
// Rendering a page can spin on a crafted PDF; bound it so it cannot hang a worker.
const PDFTOPPM_TIMEOUT_MS = 30_000;

export async function extractPdfCover(absolutePath: string): Promise<Buffer | null> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'pdf-cover-'));
  const outPrefix = join(tmpDir, 'cover');

  try {
    await execFileAsync('pdftoppm', ['-jpeg', '-singlefile', '-r', '150', '-f', '1', '-l', '1', absolutePath, outPrefix], {
      timeout: PDFTOPPM_TIMEOUT_MS,
    });
    return await readFile(`${outPrefix}.jpg`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
