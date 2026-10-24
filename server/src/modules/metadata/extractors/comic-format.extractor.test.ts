import { ZipArchive } from 'archiver';
import { createWriteStream } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { ComicFormatExtractor } from './comic-format.extractor';

async function writeCbz(absolutePath: string, comicInfoXml: string): Promise<void> {
  const output = createWriteStream(absolutePath);
  const archive = new ZipArchive({ zlib: { level: 6 } });

  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.append(Buffer.from(comicInfoXml, 'utf8'), { name: 'ComicInfo.xml' });
    archive.append(Buffer.from('fixture page', 'utf8'), { name: 'page-001.txt' });
    void archive.finalize();
  });
}

describe('ComicFormatExtractor with a real CBZ file', () => {
  let rootPath: string;

  beforeEach(async () => {
    rootPath = await mkdtemp(join(tmpdir(), 'bookorbit-comic-extractor-'));
  });

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });

  it('keeps ComicInfo Tags alongside Genre instead of dropping them', async () => {
    const cbzPath = join(rootPath, 'spread.cbz');
    await writeCbz(
      cbzPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<ComicInfo>
  <Title>Spread Issue</Title>
  <Genre>Spread</Genre>
  <Tags>Full Color, University, Hentai, Uncensored, Spread, color, schoolgirl outfit, unlimited</Tags>
</ComicInfo>`,
    );

    const result = await new ComicFormatExtractor('cbz').extract(cbzPath);

    expect(result?.genres).toEqual(['Spread']);
    expect(result?.tags).toEqual(['Full Color', 'University', 'Hentai', 'Uncensored', 'Spread', 'color', 'schoolgirl outfit', 'unlimited']);
  });

  it('reports Tags as tags only when Genre is empty', async () => {
    const cbzPath = join(rootPath, 'tags-only.cbz');
    await writeCbz(cbzPath, `<ComicInfo><Title>Tags Only</Title><Tags>Action, Drama</Tags></ComicInfo>`);

    const result = await new ComicFormatExtractor('cbz').extract(cbzPath);

    expect(result?.genres).toEqual([]);
    expect(result?.tags).toEqual(['Action', 'Drama']);
  });
});
