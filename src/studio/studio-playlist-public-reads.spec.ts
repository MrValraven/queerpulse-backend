import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publiclyListedPlaylistSql } from './studio-playlist-visibility';

/**
 * Collaborative playlists must leave every public playlist read as it was:
 * search, the persona page, the track page's "In these playlists", the
 * member profile, stats and related artists. They read
 * `publiclyListedPlaylistSql` (or the member profile's own rule), and none
 * of them may name the editors table or the editor predicates. Read from
 * the sources, so a later edit that joins editors into a public read fails
 * here.
 */
const source = (fileName: string): string =>
  readFileSync(join(__dirname, fileName), 'utf8');

/** The body of one method, from its signature to its closing brace at two
 *  spaces of indent. */
function methodBody(fileSource: string, signature: string): string {
  const start = fileSource.indexOf(signature);
  if (start === -1) {
    throw new Error(`No method starting with ${signature}`);
  }
  const end = fileSource.indexOf('\n  }\n', start);
  return fileSource.slice(start, end === -1 ? undefined : end);
}

/** A top level function, from its signature to its closing brace. */
function functionBody(fileSource: string, signature: string): string {
  const start = fileSource.indexOf(signature);
  if (start === -1) {
    throw new Error(`No function starting with ${signature}`);
  }
  const end = fileSource.indexOf('\n}\n', start);
  return fileSource.slice(start, end === -1 ? undefined : end);
}

const EDITOR_MARKERS = [
  'studio_playlist_editors',
  'viewerEditsPlaylistSql',
  'viewerHoldsLiveEditorRowSql',
  'mineListedPlaylistSql',
];

describe('Public playlist reads after collaborative playlists', () => {
  const statsSource = source('studio-stats.service.ts');
  const relatedArtistsSource = source('studio-related-artists.service.ts');
  const readsSource = source('studio-playlist-reads.service.ts');

  it('reads the sources it checks (a scan that matched nothing would pass vacuously)', () => {
    expect(statsSource).toContain('publiclyListedPlaylistSql(');
    expect(relatedArtistsSource).toContain('publiclyListedPlaylistSql(');
    expect(methodBody(readsSource, 'listMine(')).toContain(
      'mineListedPlaylistSql(',
    );
    expect(
      functionBody(readsSource, 'export function mineListedPlaylistSql('),
    ).toContain('viewerHoldsLiveEditorRowSql(');
  });

  it('keeps the editors table out of every public playlist read', () => {
    expect(publiclyListedPlaylistSql('playlist')).not.toContain(
      'studio_playlist_editors',
    );
    const publicReads = [
      statsSource,
      relatedArtistsSource,
      methodBody(readsSource, 'async searchPlaylists('),
      methodBody(readsSource, 'listCreditedToPersona('),
      methodBody(readsSource, 'async listForTrack('),
      methodBody(readsSource, 'async listCreditedToMember('),
    ];
    for (const publicRead of publicReads) {
      for (const marker of EDITOR_MARKERS) {
        expect(publicRead).not.toContain(marker);
      }
    }
  });

  it('lists search, the persona page and the track page through the public predicate', () => {
    for (const signature of [
      'async searchPlaylists(',
      'listCreditedToPersona(',
      'async listForTrack(',
    ]) {
      expect(methodBody(readsSource, signature)).toContain(
        'publiclyListedPlaylistSql(',
      );
    }
  });
});
