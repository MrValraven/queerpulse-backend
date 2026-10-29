import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  LISTENABLE_ARTIST_SQL,
  STUDIO_ARTIST_KIND_LIST_SQL,
} from './studio-discovery-sql';
import {
  playableTrackAudioSql,
  playableTrackSql,
} from './studio-playlist-visibility';
import {
  RELATED_ARTISTS_SQL,
  StudioRelatedArtistsService,
} from './studio-related-artists.service';

const VIEWER_ID = 'f4000000-0000-4000-8000-000000000001';
const ARTIST_ID = 'f4000000-0000-4000-8000-000000000002';

describe('StudioRelatedArtistsService', () => {
  let query: jest.Mock;
  let service: StudioRelatedArtistsService;

  beforeEach(() => {
    query = jest.fn((sql: string) =>
      Promise.resolve(
        sql === LISTENABLE_ARTIST_SQL
          ? [{ found: 1 }]
          : [
              {
                artist_id: 'f4000000-0000-4000-8000-000000000003',
                artist_handle: 'river-ink',
                artist_display_name: 'River Ink',
                artist_kind: 'musician',
                artist_avatar_url: null,
                score: 7,
              },
            ],
      ),
    );
    service = new StudioRelatedArtistsService({
      query,
    } as unknown as DataSource);
  });

  it('answers up to eight artist references for a listenable artist', async () => {
    const result = await service.listRelated(VIEWER_ID, ARTIST_ID);

    expect(query).toHaveBeenNthCalledWith(1, LISTENABLE_ARTIST_SQL, [
      VIEWER_ID,
      ARTIST_ID,
    ]);
    expect(query).toHaveBeenNthCalledWith(2, RELATED_ARTISTS_SQL, [
      VIEWER_ID,
      ARTIST_ID,
      8,
    ]);
    expect(result).toEqual({
      items: [
        {
          id: 'f4000000-0000-4000-8000-000000000003',
          handle: 'river-ink',
          name: 'River Ink',
          kind: 'musician',
          avatarUrl: null,
        },
      ],
    });
  });

  it('answers 404 for an artist that is not listenable, before any scoring', async () => {
    query.mockResolvedValue([]);
    await expect(
      service.listRelated(VIEWER_ID, ARTIST_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reads playable tracks through the shared v2 rule, the persona checked on the candidate', () => {
    expect(RELATED_ARTISTS_SQL).toContain(
      playableTrackAudioSql('artist_track', 'artist_release'),
    );
    expect(RELATED_ARTISTS_SQL).toContain(
      playableTrackAudioSql('other_track', 'other_release'),
    );
    expect(playableTrackAudioSql('track', 'release')).toContain(
      '"track"."duration_seconds" IS NOT NULL',
    );
    expect(playableTrackAudioSql('track', 'release')).not.toContain(
      'content_moderation',
    );
    expect(playableTrackSql('track', 'release', 'persona')).toContain(
      playableTrackAudioSql('track', 'release'),
    );
  });

  it('scores accepted credits on published tracks in either direction, capped at 12', () => {
    expect(RELATED_ARTISTS_SQL).toContain(
      'LEAST(COUNT(DISTINCT "track_id") * 4, 12)',
    );
    expect(RELATED_ARTISTS_SQL).toContain(`"credit"."status" = 'accepted'`);
    expect(RELATED_ARTISTS_SQL).toContain('"credit"."subprofile_id" = $2');
    expect(RELATED_ARTISTS_SQL).toContain('"release"."subprofile_id" = $2');
    expect(RELATED_ARTISTS_SQL).not.toContain(`'pending'`);
  });

  it('reads public playlists only and counts them from two distinct owners', () => {
    expect(RELATED_ARTISTS_SQL).toContain(`"playlist"."visibility" = 'public'`);
    expect(RELATED_ARTISTS_SQL).toContain(
      'HAVING COUNT(DISTINCT "owner_id") >= 2',
    );
    expect(RELATED_ARTISTS_SQL).toContain('LEAST(COUNT(*) * 2, 8)');
    expect(RELATED_ARTISTS_SQL).not.toContain(`'connections'`);
    expect(RELATED_ARTISTS_SQL).not.toContain(`'private'`);
  });

  it('adds 2 for a shared active scene and 1 per shared genre up to 2', () => {
    expect(RELATED_ARTISTS_SQL).toContain(`"scene"."status" = 'active'`);
    expect(RELATED_ARTISTS_SQL).toContain('2 AS "score"');
    expect(RELATED_ARTISTS_SQL).toContain('LEAST(COUNT(*), 2)');
  });

  // A release lists up to 5 genres: every one of them counts for the match.
  it('counts shared genres over every genre of every published release', () => {
    expect(RELATED_ARTISTS_SQL).toContain(
      'unnest("other_release"."genres") AS "other_item"("genre_value")',
    );
    expect(RELATED_ARTISTS_SQL).toContain(
      'unnest("artist_release"."genres") AS "artist_item"("genre_value")',
    );
    expect(RELATED_ARTISTS_SQL).toContain(
      'ON "artist_genre"."genre_value" = "other_genre"."genre_value"',
    );
    expect(RELATED_ARTISTS_SQL).not.toContain('"genre" IS NOT NULL');
  });

  it('keeps listenable artist candidates clear of blocks, the artist itself excluded, zero scores dropped', () => {
    expect(RELATED_ARTISTS_SQL).toContain('"persona"."id" <> $2');
    expect(RELATED_ARTISTS_SQL).toContain(
      `"persona"."kind" IN (${STUDIO_ARTIST_KIND_LIST_SQL})`,
    );
    expect(RELATED_ARTISTS_SQL).toContain('FROM "blocks" "candidate_block"');
    expect(RELATED_ARTISTS_SQL).toContain('WHERE "scored"."score" > 0');
    expect(RELATED_ARTISTS_SQL).toContain(
      'ORDER BY "scored"."score" DESC, "scored"."newest_published_at" DESC, "scored"."artist_id" ASC',
    );
    expect(RELATED_ARTISTS_SQL).toContain('LIMIT $3');
  });

  // Discovery reads no personal signal: plays, saves and follows never
  // enter the score.
  it('reads no saves, follows or listening tables', () => {
    for (const table of ['saved_items', 'subprofile_followers', 'listens']) {
      expect(RELATED_ARTISTS_SQL).not.toContain(table);
    }
  });
});
