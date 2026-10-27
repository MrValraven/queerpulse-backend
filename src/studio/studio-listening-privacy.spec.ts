import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const SOURCE_ROOT = join(REPO_ROOT, 'src');

const LISTENING_TABLES =
  /studio_listens|studio_supporters|studio_track_play_daily/;

const FILES_ALLOWED_TO_NAME_LISTENING_TABLES = [
  'src/account/data-export-contributors-studio.ts',
  'src/migrations/1837800000000-AddStudioListening.ts',
  'src/studio/entities/studio-listen.entity.ts',
  'src/studio/entities/studio-supporter.entity.ts',
  'src/studio/entities/studio-track-play-daily.entity.ts',
  'src/studio/studio-artist-plays.service.ts',
  'src/studio/studio-listening-history.service.ts',
  'src/studio/studio-listening-prune.service.ts',
  'src/studio/studio-listening-unlink.ts',
  'src/studio/studio-play-milestones.service.ts',
  'src/studio/studio-plays.service.ts',
  'src/studio/studio-stats.service.ts',
  'src/studio/studio-supporters.service.ts',
];

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectSourceFiles(entryPath);
    }
    const isSource =
      entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts');
    return isSource ? [entryPath] : [];
  });
}

function sourceFilesMatching(pattern: RegExp): string[] {
  return collectSourceFiles(SOURCE_ROOT)
    .filter((filePath) => pattern.test(readFileSync(filePath, 'utf8')))
    .map((filePath) => relative(REPO_ROOT, filePath).split('\\').join('/'))
    .sort();
}

describe('listening privacy', () => {
  it('keeps the listening tables to the files that serve the member, the owners, the export and the unlink', () => {
    expect(
      sourceFilesMatching(LISTENING_TABLES).filter(
        (file) => !FILES_ALLOWED_TO_NAME_LISTENING_TABLES.includes(file),
      ),
    ).toEqual([]);
  });

  it('lets no admin, moderation or staff file read a listening table', () => {
    expect(
      sourceFilesMatching(LISTENING_TABLES).filter((file) =>
        /admin|moderation|staff/.test(file),
      ),
    ).toEqual([]);
  });
});
