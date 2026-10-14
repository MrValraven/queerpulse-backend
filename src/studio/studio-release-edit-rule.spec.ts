import { HttpException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import {
  STAMP_TRACKS_CHANGED_SQL,
  TRACK_EDITABLE_RELEASE_STATUSES,
  assertKeepsPlayableTrack,
  assertTracksEditable,
  isLiveOrUpcomingStatus,
  nextVersionNumber,
  stampTracksChangedIfPublished,
} from './studio-release-edit-rule';

const RELEASE_ID = 'c1000000-0000-4000-8000-000000000001';
const AUDIO_KEY = 'studio-audio/a/b.mp3';

function codeOf(work: () => void): string | undefined {
  try {
    work();
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

describe('Studio release edit rule', () => {
  it('opens track edits on drafts, scheduled and published releases', () => {
    expect(TRACK_EDITABLE_RELEASE_STATUSES).toEqual([
      StudioReleaseStatus.Draft,
      StudioReleaseStatus.Scheduled,
      StudioReleaseStatus.Published,
    ]);
    for (const status of TRACK_EDITABLE_RELEASE_STATUSES) {
      expect(codeOf(() => assertTracksEditable({ status }))).toBeUndefined();
    }
    expect(
      codeOf(() =>
        assertTracksEditable({ status: StudioReleaseStatus.TakenDown }),
      ),
    ).toBe('studio_release_not_draft');
  });

  it('treats scheduled and published releases as live or upcoming', () => {
    expect(isLiveOrUpcomingStatus(StudioReleaseStatus.Scheduled)).toBe(true);
    expect(isLiveOrUpcomingStatus(StudioReleaseStatus.Published)).toBe(true);
    expect(isLiveOrUpcomingStatus(StudioReleaseStatus.Draft)).toBe(false);
  });

  it('refuses to leave a live or upcoming release with no playable track', () => {
    const pendingTrack = { audioKey: null, durationSeconds: null };
    const playableTrack = { audioKey: AUDIO_KEY, durationSeconds: 200 };
    for (const status of [
      StudioReleaseStatus.Published,
      StudioReleaseStatus.Scheduled,
    ]) {
      expect(
        codeOf(() => assertKeepsPlayableTrack({ status }, [pendingTrack])),
      ).toBe('studio_release_needs_playable_track');
      expect(codeOf(() => assertKeepsPlayableTrack({ status }, []))).toBe(
        'studio_release_needs_playable_track',
      );
      expect(
        codeOf(() => assertKeepsPlayableTrack({ status }, [playableTrack])),
      ).toBeUndefined();
    }
    expect(
      codeOf(() =>
        assertKeepsPlayableTrack({ status: StudioReleaseStatus.Draft }, []),
      ),
    ).toBeUndefined();
  });

  it('stamps a track change on a published release only, on the statement clock', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const manager = { query } as unknown as EntityManager;
    await stampTracksChangedIfPublished(manager, {
      id: RELEASE_ID,
      status: StudioReleaseStatus.Draft,
    });
    await stampTracksChangedIfPublished(manager, {
      id: RELEASE_ID,
      status: StudioReleaseStatus.Scheduled,
    });
    expect(query).not.toHaveBeenCalled();
    await stampTracksChangedIfPublished(manager, {
      id: RELEASE_ID,
      status: StudioReleaseStatus.Published,
    });
    expect(query).toHaveBeenCalledWith(STAMP_TRACKS_CHANGED_SQL, [RELEASE_ID]);
    expect(STAMP_TRACKS_CHANGED_SQL).toContain('clock_timestamp()');
  });

  it('numbers the first note version 2 and counts on from the newest', () => {
    expect(nextVersionNumber(null)).toBe(2);
    expect(nextVersionNumber(2)).toBe(3);
    expect(nextVersionNumber(7)).toBe(8);
  });

  // Studio artist kinds: a podcast show is outside the version tools, and a
  // published show keeps an episode listeners can hear.
  it('never stamps a podcast show', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const manager = { query } as unknown as EntityManager;
    await stampTracksChangedIfPublished(manager, {
      id: RELEASE_ID,
      status: StudioReleaseStatus.Published,
      type: StudioReleaseType.Podcast,
    });
    expect(query).not.toHaveBeenCalled();
    expect(STAMP_TRACKS_CHANGED_SQL).toContain(`"type" <> 'podcast'`);
    await stampTracksChangedIfPublished(manager, {
      id: RELEASE_ID,
      status: StudioReleaseStatus.Published,
      type: StudioReleaseType.Mix,
    });
    expect(query).toHaveBeenCalledWith(STAMP_TRACKS_CHANGED_SQL, [RELEASE_ID]);
  });

  it('asks a published show to keep a published episode', () => {
    const show = {
      status: StudioReleaseStatus.Published,
      type: StudioReleaseType.Podcast,
    };
    const draftEpisode = {
      audioKey: AUDIO_KEY,
      durationSeconds: 1800,
      publishedAt: null,
    };
    const publishedEpisode = {
      ...draftEpisode,
      publishedAt: new Date('2026-10-01T09:00:00.000Z'),
    };
    expect(codeOf(() => assertKeepsPlayableTrack(show, [draftEpisode]))).toBe(
      'studio_release_needs_playable_track',
    );
    expect(
      codeOf(() =>
        assertKeepsPlayableTrack(show, [draftEpisode, publishedEpisode]),
      ),
    ).toBeUndefined();
    expect(
      codeOf(() =>
        assertKeepsPlayableTrack(
          {
            status: StudioReleaseStatus.Scheduled,
            type: StudioReleaseType.Podcast,
          },
          [draftEpisode],
        ),
      ),
    ).toBeUndefined();
  });
});
