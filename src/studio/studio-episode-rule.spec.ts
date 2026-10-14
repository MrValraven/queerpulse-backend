import { HttpException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import {
  STAMP_SHOW_EPISODES_SQL,
  assertEpisodePublishable,
  assertTrackOrderUnlocked,
  byEpisodeOrder,
  episodeReleasedSql,
  isDraftEpisode,
  isPodcastRelease,
  isTrackReleasedToListeners,
  stampShowEpisodes,
  toNotesExcerpt,
} from './studio-episode-rule';

const SHOW_ID = 'f1000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-10-14T12:00:00.000Z');
const AUDIO_KEY = 'studio-audio/a/b.mp3';
const show = { type: StudioReleaseType.Podcast };
const mix = { type: StudioReleaseType.Mix };

function codeOf(work: () => void): string | undefined {
  try {
    work();
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

describe('Studio episode rule', () => {
  it('knows a podcast show by its type', () => {
    expect(isPodcastRelease(show)).toBe(true);
    expect(isPodcastRelease(mix)).toBe(false);
    expect(isPodcastRelease({})).toBe(false);
  });

  it('spells the playable arm on the given aliases', () => {
    const arm = episodeReleasedSql('artist_track', 'artist_release');
    expect(arm).toContain(`"artist_release"."type" <> 'podcast'`);
    expect(arm).toContain(`"artist_track"."published_at" IS NOT NULL`);
    expect(arm).toContain(`"artist_track"."published_at" <= now()`);
    expect(arm.startsWith('(')).toBe(true);
    expect(arm.endsWith(')')).toBe(true);
  });

  it('lets every track of another type through and an episode once its time has come', () => {
    expect(isTrackReleasedToListeners({ publishedAt: null }, mix, NOW)).toBe(
      true,
    );
    expect(isTrackReleasedToListeners({ publishedAt: null }, show, NOW)).toBe(
      false,
    );
    expect(
      isTrackReleasedToListeners(
        { publishedAt: new Date('2026-10-14T11:00:00.000Z') },
        show,
        NOW,
      ),
    ).toBe(true);
    expect(isTrackReleasedToListeners({ publishedAt: NOW }, show, NOW)).toBe(
      true,
    );
    expect(
      isTrackReleasedToListeners(
        { publishedAt: new Date('2026-10-14T12:00:00.001Z') },
        show,
        NOW,
      ),
    ).toBe(false);
  });

  it('marks an unpublished episode as a draft and nothing else', () => {
    expect(isDraftEpisode({ publishedAt: null }, show)).toBe(true);
    expect(isDraftEpisode({ publishedAt: NOW }, show)).toBe(false);
    expect(isDraftEpisode({ publishedAt: null }, mix)).toBe(false);
  });

  it('orders episodes by publish time, then by stored position', () => {
    const tracks = [
      { position: 3, publishedAt: new Date('2026-10-02T09:00:00.000Z') },
      { position: 2, publishedAt: new Date('2026-10-01T09:00:00.000Z') },
      { position: 1, publishedAt: new Date('2026-10-01T09:00:00.000Z') },
      { position: 4, publishedAt: null },
    ];
    expect(
      [...tracks].sort(byEpisodeOrder).map((track) => track.position),
    ).toEqual([1, 2, 3, 4]);
  });

  it('stamps the publish time and the claim marker in one statement, on unstamped episodes with audio', async () => {
    expect(STAMP_SHOW_EPISODES_SQL).toContain('"published_at" = $2');
    expect(STAMP_SHOW_EPISODES_SQL).toContain(
      '"followers_notified_at" = now()',
    );
    expect(STAMP_SHOW_EPISODES_SQL).toContain('"published_at" IS NULL');
    expect(STAMP_SHOW_EPISODES_SQL).toContain('"audio_key" IS NOT NULL');
    expect(STAMP_SHOW_EPISODES_SQL).toContain('"duration_seconds" IS NOT NULL');
    expect(STAMP_SHOW_EPISODES_SQL).toContain('"release_id" = $1');
    expect(STAMP_SHOW_EPISODES_SQL).toContain(
      `"stamped_release"."type" = 'podcast'`,
    );
    const query = jest.fn().mockResolvedValue(undefined);
    const manager = { query } as unknown as EntityManager;
    await stampShowEpisodes(manager, { id: SHOW_ID, ...mix }, NOW);
    expect(query).not.toHaveBeenCalled();
    await stampShowEpisodes(manager, { id: SHOW_ID, ...show }, NOW);
    expect(query).toHaveBeenCalledWith(STAMP_SHOW_EPISODES_SQL, [SHOW_ID, NOW]);
  });

  it('publishes an episode of a published show once its audio is in', () => {
    const published = { ...show, status: StudioReleaseStatus.Published };
    const draftEpisode = {
      publishedAt: null,
      audioKey: AUDIO_KEY,
      durationSeconds: 1800,
    };
    expect(
      codeOf(() => assertEpisodePublishable(published, draftEpisode)),
    ).toBeUndefined();
    expect(
      codeOf(() =>
        assertEpisodePublishable(
          { ...mix, status: StudioReleaseStatus.Published },
          draftEpisode,
        ),
      ),
    ).toBe('studio_not_a_podcast');
    expect(
      codeOf(() =>
        assertEpisodePublishable(
          { ...show, status: StudioReleaseStatus.Draft },
          draftEpisode,
        ),
      ),
    ).toBe('studio_episode_show_not_published');
    expect(
      codeOf(() =>
        assertEpisodePublishable(
          { ...show, status: StudioReleaseStatus.Scheduled },
          draftEpisode,
        ),
      ),
    ).toBe('studio_episode_show_not_published');
    expect(
      codeOf(() =>
        assertEpisodePublishable(published, {
          ...draftEpisode,
          publishedAt: NOW,
        }),
      ),
    ).toBe('studio_episode_already_published');
    expect(
      codeOf(() =>
        assertEpisodePublishable(published, {
          ...draftEpisode,
          durationSeconds: null,
        }),
      ),
    ).toBe('studio_publish_tracks_pending');
  });

  it('locks the order of a published show only', () => {
    expect(
      codeOf(() =>
        assertTrackOrderUnlocked({
          ...show,
          status: StudioReleaseStatus.Published,
        }),
      ),
    ).toBe('studio_episode_order_locked');
    for (const status of [
      StudioReleaseStatus.Draft,
      StudioReleaseStatus.Scheduled,
    ]) {
      expect(
        codeOf(() => assertTrackOrderUnlocked({ ...show, status })),
      ).toBeUndefined();
    }
    expect(
      codeOf(() =>
        assertTrackOrderUnlocked({
          ...mix,
          status: StudioReleaseStatus.Published,
        }),
      ),
    ).toBeUndefined();
  });

  describe('toNotesExcerpt', () => {
    it('reads no notes and blank notes as none', () => {
      expect(toNotesExcerpt(null)).toBeNull();
      expect(toNotesExcerpt(undefined)).toBeNull();
      expect(toNotesExcerpt('  \n ')).toBeNull();
    });

    it('keeps short notes with whitespace collapsed', () => {
      expect(toNotesExcerpt('Two   friends\ntalk shop')).toBe(
        'Two friends talk shop',
      );
    });

    it('drops chapter lines and keeps the first paragraph', () => {
      expect(
        toNotesExcerpt(
          'Dating apps and what you want\n\nSecond paragraph\n\n00:00 Cold open\n06:30 The apps\n1:02:03 - Wrap',
        ),
      ).toBe('Dating apps and what you want');
      expect(toNotesExcerpt('Still editing this one\n00:00 Intro')).toBe(
        'Still editing this one',
      );
    });

    it('reads notes that are only chapter lines as none', () => {
      expect(toNotesExcerpt('00:00 Intro\n01:30 Housing')).toBeNull();
    });

    it('cuts long notes on the last space within 200 characters and marks the cut', () => {
      const notes = `${'word '.repeat(50)}tail`;
      const excerpt = toNotesExcerpt(notes)!;
      expect(excerpt.endsWith('…')).toBe(true);
      expect(excerpt.length).toBeLessThanOrEqual(201);
      expect(excerpt.slice(0, -1)).toBe('word '.repeat(40).trim());
    });

    it('cuts notes with no space at 200 characters', () => {
      expect(toNotesExcerpt('x'.repeat(300))).toBe(`${'x'.repeat(200)}…`);
    });
  });
});
