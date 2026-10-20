import { SubprofileKind } from '../subprofiles/entities/subprofile.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import {
  StudioReleaseDispute,
  StudioReleaseDisputeStatus,
} from './entities/studio-release-dispute.entity';
import { StudioScene, StudioSceneState } from './entities/studio-scene.entity';
import { StudioTrack } from './entities/studio-track.entity';
import {
  EMPTY_RELEASE_STATS,
  StudioArtistPersona,
  StudioReleaseExtras,
  canFileStudioDispute,
  hasUnnotedTrackChanges,
  isListenerPlayableTrack,
  listenerStatsForTracks,
  statsForTracks,
  toListenerTrackSummaries,
  toStudioArtistRef,
  toStudioFormatArtistRef,
  toStudioOwnerReleaseCard,
  toStudioReleaseCard,
  toStudioReleaseDisputeView,
  toStudioReleaseResponse,
  toStudioStream,
  toStudioTrackResponse,
  toStudioTrackSummary,
} from './studio-response';
import {
  StudioClaimantRole,
  StudioCopyrightClaimStatus,
} from './entities/studio-copyright-claim.entity';
import { StudioOwnerClaim } from './studio-claim-response';

const persona = (
  overrides: Partial<StudioArtistPersona> = {},
): StudioArtistPersona =>
  ({
    id: 'persona-1',
    handle: 'night-shift',
    displayName: 'Night Shift',
    kind: 'dj',
    avatarUrl: null,
    ...overrides,
  }) as StudioArtistPersona;

const track = (overrides: Partial<StudioTrack>): StudioTrack =>
  ({
    id: 'track-1',
    releaseId: 'release-1',
    position: 1,
    title: 'Opening',
    audioKey: 'studio-audio/a/b.mp3',
    audioContentType: 'audio/mpeg',
    audioBytes: 10,
    durationSeconds: 200,
    credits: [],
    lyrics: null,
    isExplicit: false,
    ...overrides,
  }) as StudioTrack;

const release = (overrides: Partial<StudioRelease> = {}): StudioRelease =>
  ({
    id: 'release-1',
    subprofileId: 'persona-1',
    title: 'Lisbon at four',
    type: StudioReleaseType.Mix,
    description: null,
    genre: null,
    coverKey: null,
    releasedOn: '2026-10-01',
    status: StudioReleaseStatus.Published,
    publishedAt: new Date('2026-10-01T09:00:00.000Z'),
    rightsConfirmedAt: new Date('2026-09-30T09:00:00.000Z'),
    takenDownAt: null,
    takenDownById: null,
    takedownReason: 'Uploaded twice',
    ...overrides,
  }) as StudioRelease;

const PEAKS = Array.from({ length: 200 }, (_unused, index) => index);
const SUMMARY_KEYS = [
  'contentWarnings',
  'durationSeconds',
  'hasAudio',
  'id',
  'isDraft',
  'isExplicit',
  'isWithheld',
  'notesExcerpt',
  'position',
  'publishedAt',
  'title',
];
const TIMED_LYRICS = [
  { ms: 0, text: 'First line' },
  { ms: 4000, text: '' },
];
const CHAPTERS = [
  { startSeconds: 0, title: 'Intro', artist: null },
  { startSeconds: 95, title: 'Second', artist: 'Ana Moura' },
];

describe('Studio response mappers', () => {
  it('reads a persona kind outside the artist kinds as musician', () => {
    expect(toStudioArtistRef(persona({ kind: 'writer' } as never)).kind).toBe(
      'musician',
    );
    expect(toStudioArtistRef(persona()).kind).toBe('dj');
  });

  it('writes an empty handle for a persona that has none', () => {
    expect(toStudioArtistRef(persona({ handle: null })).handle).toBe('');
  });

  it('carries no owner identity in the artist reference', () => {
    expect(Object.keys(toStudioArtistRef(persona())).sort()).toEqual([
      'avatarUrl',
      'handle',
      'id',
      'kind',
      'name',
    ]);
  });

  it('counts every track and sums only tracks that have audio', () => {
    expect(
      statsForTracks([
        track({ durationSeconds: 200 }),
        track({ id: 'track-2', audioKey: null, durationSeconds: null }),
        track({ id: 'track-3', durationSeconds: 100 }),
      ]),
    ).toEqual({ trackCount: 3, totalDurationSeconds: 300 });
  });

  it('orders tracks by position and marks the ones without audio for an owner', () => {
    const response = toStudioReleaseResponse(
      release(),
      persona(),
      [
        track({
          id: 'track-2',
          position: 2,
          audioKey: null,
          durationSeconds: null,
        }),
        track({ id: 'track-1', position: 1 }),
      ],
      { isOwner: true, isStaff: false },
    );
    expect(response.tracks.map((summary) => summary.id)).toEqual([
      'track-1',
      'track-2',
    ]);
    expect(response.tracks.map((summary) => summary.hasAudio)).toEqual([
      true,
      false,
    ]);
  });

  it('shows owner fields to owners and staff, and null to listeners', () => {
    const listener = toStudioReleaseResponse(release(), persona(), [], {
      isOwner: false,
      isStaff: false,
    });
    const owner = toStudioReleaseResponse(release(), persona(), [], {
      isOwner: true,
      isStaff: false,
    });
    const staff = toStudioReleaseResponse(release(), persona(), [], {
      isOwner: false,
      isStaff: true,
    });
    expect(listener.rightsConfirmedAt).toBeNull();
    expect(listener.takedownReason).toBeNull();
    expect(owner.rightsConfirmedAt).toBe('2026-09-30T09:00:00.000Z');
    expect(owner.isOwner).toBe(true);
    expect(staff.takedownReason).toBe('Uploaded twice');
    expect(staff.isOwner).toBe(false);
  });

  // Studio v2: Play all keeps the server's order, so every card carries the
  // publish time the feed sorts on, and the genre the browse page filters on.
  it('carries the publish time and the genre on every release card', () => {
    const card = toStudioReleaseCard(release({ genre: 'fado' }), persona(), {
      trackCount: 1,
      totalDurationSeconds: 200,
    });
    expect(card.publishedAt).toBe('2026-10-01T09:00:00.000Z');
    expect(card.genre).toBe('fado');
  });

  it('writes null for a draft that has no publish time and no genre', () => {
    const card = toStudioOwnerReleaseCard(
      release({ status: StudioReleaseStatus.Draft, publishedAt: null }),
      persona(),
      EMPTY_RELEASE_STATS,
    );
    expect(card.publishedAt).toBeNull();
    expect(card.genre).toBeNull();
    expect(card.status).toBe('draft');
  });

  it('keeps the publish time and genre on the full release response', () => {
    const response = toStudioReleaseResponse(
      release({ genre: 'ambient' }),
      persona(),
      [],
      { isOwner: false, isStaff: false },
    );
    expect(response.publishedAt).toBe('2026-10-01T09:00:00.000Z');
    expect(response.genre).toBe('ambient');
  });

  // Studio v3.
  const pendingTrack = (id: string, position: number) =>
    track({ id, position, audioKey: null, durationSeconds: null });

  it('hides a track still uploading from listeners and numbers the rest from 1', () => {
    const response = toStudioReleaseResponse(
      release(),
      persona(),
      [
        track({ id: 'track-3', position: 3, durationSeconds: 100 }),
        pendingTrack('track-1', 1),
        track({ id: 'track-2', position: 2, durationSeconds: 200 }),
      ],
      { isOwner: false, isStaff: false },
    );
    expect(
      response.tracks.map((summary) => [summary.id, summary.position]),
    ).toEqual([
      ['track-2', 1],
      ['track-3', 2],
    ]);
    expect(response.trackCount).toBe(2);
    expect(response.totalDurationSeconds).toBe(300);
  });

  it('shows the owner every track at its stored position and counts them all', () => {
    const response = toStudioReleaseResponse(
      release(),
      persona(),
      [pendingTrack('track-1', 1), track({ id: 'track-2', position: 2 })],
      { isOwner: true, isStaff: false },
    );
    expect(
      response.tracks.map((summary) => [summary.id, summary.position]),
    ).toEqual([
      ['track-1', 1],
      ['track-2', 2],
    ]);
    expect(response.trackCount).toBe(2);
  });

  it('gives a non-owner no tracks on a scheduled release and keeps the playable count and length', () => {
    const response = toStudioReleaseResponse(
      release({
        status: StudioReleaseStatus.Scheduled,
        publishedAt: null,
        publishAt: new Date('2026-10-20T18:00:00.000Z'),
      }),
      persona(),
      [
        track({ id: 'track-1', position: 1, durationSeconds: 200 }),
        pendingTrack('track-2', 2),
      ],
      { isOwner: false, isStaff: false },
    );
    expect(response.tracks).toEqual([]);
    expect(response.trackCount).toBe(1);
    expect(response.totalDurationSeconds).toBe(200);
    expect(response.publishAt).toBe('2026-10-20T18:00:00.000Z');
  });

  it('gives a preview every track with audio, renumbered, on a scheduled release', () => {
    const response = toStudioReleaseResponse(
      release({
        status: StudioReleaseStatus.Scheduled,
        publishedAt: null,
        publishAt: new Date('2026-10-20T18:00:00.000Z'),
      }),
      persona(),
      [pendingTrack('track-1', 1), track({ id: 'track-2', position: 2 })],
      { isOwner: false, isStaff: false, isPreview: true },
    );
    expect(response.isPreview).toBe(true);
    expect(
      response.tracks.map((summary) => [summary.id, summary.position]),
    ).toEqual([['track-2', 1]]);
  });

  it('reads version 1 with no notes and the newest note as the version', () => {
    const extras: StudioReleaseExtras = {
      supportLinks: [{ platform: 'bandcamp', urlOrHandle: 'nightshift' }],
      versions: [
        {
          version: 3,
          note: 'Fixed the fade',
          createdAt: new Date('2026-10-12T09:00:00.000Z'),
        },
        {
          version: 2,
          note: 'Added a bonus track',
          createdAt: new Date('2026-10-10T09:00:00.000Z'),
        },
      ],
      isReminderSet: false,
    };
    const plain = toStudioReleaseResponse(release(), persona(), [], {
      isOwner: false,
      isStaff: false,
    });
    expect(plain.version).toBe(1);
    expect(plain.versions).toEqual([]);
    expect(plain.supportLinks).toEqual([]);
    const noted = toStudioReleaseResponse(
      release(),
      persona(),
      [],
      { isOwner: false, isStaff: false },
      [],
      [],
      extras,
    );
    expect(noted.version).toBe(3);
    expect(noted.versions).toEqual([
      {
        version: 3,
        note: 'Fixed the fade',
        createdAt: '2026-10-12T09:00:00.000Z',
      },
      {
        version: 2,
        note: 'Added a bonus track',
        createdAt: '2026-10-10T09:00:00.000Z',
      },
    ]);
    expect(noted.supportLinks).toEqual(extras.supportLinks);
  });

  it('shows the preview link and unnoted changes to the owner alone', () => {
    const withLink = release({
      previewToken: 'a'.repeat(64),
      previewLinkCreatedAt: new Date('2026-10-11T09:00:00.000Z'),
      tracksChangedAt: new Date('2026-10-05T09:00:00.000Z'),
    });
    const owner = toStudioReleaseResponse(withLink, persona(), [], {
      isOwner: true,
      isStaff: false,
    });
    const listener = toStudioReleaseResponse(withLink, persona(), [], {
      isOwner: false,
      isStaff: false,
    });
    const staff = toStudioReleaseResponse(withLink, persona(), [], {
      isOwner: false,
      isStaff: true,
    });
    expect(owner.previewToken).toBe('a'.repeat(64));
    expect(owner.previewLinkCreatedAt).toBe('2026-10-11T09:00:00.000Z');
    expect(owner.hasUnnotedChanges).toBe(true);
    for (const view of [listener, staff]) {
      expect(view.previewToken).toBeNull();
      expect(view.previewLinkCreatedAt).toBeNull();
      expect(view.hasUnnotedChanges).toBe(false);
    }
  });

  it('reports a reminder only on a scheduled release', () => {
    const extras: StudioReleaseExtras = {
      supportLinks: [],
      versions: [],
      isReminderSet: true,
    };
    const published = toStudioReleaseResponse(
      release(),
      persona(),
      [],
      { isOwner: false, isStaff: false },
      [],
      [],
      extras,
    );
    const scheduled = toStudioReleaseResponse(
      release({
        status: StudioReleaseStatus.Scheduled,
        publishedAt: null,
        publishAt: new Date('2026-10-20T18:00:00.000Z'),
      }),
      persona(),
      [],
      { isOwner: false, isStaff: false },
      [],
      [],
      extras,
    );
    expect(published.isReminderSet).toBe(false);
    expect(scheduled.isReminderSet).toBe(true);
  });

  it('carries the buy link and null for the v3 fields a release never set', () => {
    const bought = toStudioReleaseResponse(
      release({ buyUrl: 'https://nightshift.bandcamp.com/album/x' }),
      persona(),
      [],
      { isOwner: false, isStaff: false },
    );
    expect(bought.buyUrl).toBe('https://nightshift.bandcamp.com/album/x');
    const bare = toStudioReleaseResponse(release(), persona(), [], {
      isOwner: false,
      isStaff: false,
    });
    expect(bare.buyUrl).toBeNull();
    expect(bare.publishAt).toBeNull();
    expect(bare.isPreview).toBe(false);
  });

  it('puts the publish time on an owner card for a scheduled release', () => {
    const card = toStudioOwnerReleaseCard(
      release({
        status: StudioReleaseStatus.Scheduled,
        publishedAt: null,
        publishAt: new Date('2026-10-20T18:00:00.000Z'),
      }),
      persona(),
      EMPTY_RELEASE_STATS,
    );
    expect(card.publishAt).toBe('2026-10-20T18:00:00.000Z');
    expect(card.status).toBe('scheduled');
  });

  it('numbers listener summaries by playable order', () => {
    expect(
      toListenerTrackSummaries([
        pendingTrack('track-1', 1),
        track({ id: 'track-2', position: 2 }),
      ]).map((summary) => summary.position),
    ).toEqual([1]);
  });

  // Studio listening: the release editor prefills timed lyrics and chapters
  // and measures the owner's tracks that have no analysis yet.
  it('gives owner rows the measuring state, the loudness pair, timed lyrics and chapters', () => {
    const response = toStudioReleaseResponse(
      release(),
      persona(),
      [
        track({
          waveformPeaks: PEAKS,
          loudnessLufs: -9.5,
          peakDb: -0.4,
          syncedLyrics: TIMED_LYRICS,
          chapters: CHAPTERS,
        }),
        track({
          id: 'track-2',
          position: 2,
          waveformPeaks: null,
          loudnessLufs: -9.5,
          peakDb: -0.4,
          syncedLyrics: null,
          chapters: null,
        }),
      ],
      { isOwner: true, isStaff: false },
    );
    expect(response.tracks[0]).toEqual(
      expect.objectContaining({
        hasAnalysis: true,
        loudnessLufs: -9.5,
        peakDb: -0.4,
        syncedLyrics: TIMED_LYRICS,
        chapters: CHAPTERS,
      }),
    );
    // Measured loudness without peaks: not analysed, and the loudness note
    // still reads the pair.
    expect(response.tracks[1]).toEqual(
      expect.objectContaining({
        hasAnalysis: false,
        loudnessLufs: -9.5,
        peakDb: -0.4,
        syncedLyrics: null,
        chapters: null,
      }),
    );
  });

  it('keeps listener and staff rows to the summary keys', () => {
    for (const viewer of [
      { isOwner: false, isStaff: false },
      { isOwner: false, isStaff: true },
    ]) {
      const response = toStudioReleaseResponse(
        release(),
        persona(),
        [
          track({
            loudnessLufs: -9.5,
            peakDb: -0.4,
            syncedLyrics: TIMED_LYRICS,
            chapters: CHAPTERS,
          }),
        ],
        viewer,
      );
      expect(Object.keys(response.tracks[0]!).sort()).toEqual(SUMMARY_KEYS);
    }
  });

  it('serves timed lyrics and chapters on the track detail, with no analysis flag', () => {
    const detail = toStudioTrackResponse(
      track({ syncedLyrics: TIMED_LYRICS, chapters: CHAPTERS }),
      toStudioReleaseCard(release(), persona(), EMPTY_RELEASE_STATS),
    );
    expect(detail.syncedLyrics).toEqual(TIMED_LYRICS);
    expect(detail.chapters).toEqual(CHAPTERS);
    expect(detail).not.toHaveProperty('hasAnalysis');
    expect(detail).not.toHaveProperty('loudnessLufs');
  });

  it('reads a track written before the listening fields as nulls', () => {
    const detail = toStudioTrackResponse(
      track({}),
      toStudioReleaseCard(release(), persona(), EMPTY_RELEASE_STATS),
    );
    expect(detail.syncedLyrics).toBeNull();
    expect(detail.chapters).toBeNull();
  });

  it('puts the stored measurements beside the signed URL', () => {
    const signedStream = {
      url: 'https://bucket.example/stream',
      expiresAt: '2026-10-13T12:15:00.000Z',
    };
    expect(
      toStudioStream(signedStream, {
        waveformPeaks: PEAKS,
        loudnessLufs: -7.8,
        peakDb: -0.1,
      }),
    ).toEqual({
      ...signedStream,
      waveformPeaks: PEAKS,
      loudnessLufs: -7.8,
      peakDb: -0.1,
    });
    expect(
      toStudioStream(signedStream, {
        waveformPeaks: null,
        loudnessLufs: null,
        peakDb: null,
      }),
    ).toEqual({
      ...signedStream,
      waveformPeaks: null,
      loudnessLufs: null,
      peakDb: null,
    });
  });
});

describe('hasUnnotedTrackChanges', () => {
  const published = (
    tracksChangedAt: Date | null,
  ): Parameters<typeof hasUnnotedTrackChanges>[0] => ({
    status: StudioReleaseStatus.Published,
    publishedAt: new Date('2026-10-01T09:00:00.000Z'),
    tracksChangedAt,
  });

  it('is false with no stamped change', () => {
    expect(hasUnnotedTrackChanges(published(null), null)).toBe(false);
  });

  it('is true for a change after the publish and no note yet', () => {
    expect(
      hasUnnotedTrackChanges(
        published(new Date('2026-10-02T09:00:00.000Z')),
        null,
      ),
    ).toBe(true);
  });

  it('is false once a note is newer than the change, and true again after a later change', () => {
    const noteAt = new Date('2026-10-03T09:00:00.000Z');
    expect(
      hasUnnotedTrackChanges(
        published(new Date('2026-10-02T09:00:00.000Z')),
        noteAt,
      ),
    ).toBe(false);
    expect(
      hasUnnotedTrackChanges(
        published(new Date('2026-10-04T09:00:00.000Z')),
        noteAt,
      ),
    ).toBe(true);
  });

  it('is false for a change older than a later republish', () => {
    expect(
      hasUnnotedTrackChanges(
        {
          status: StudioReleaseStatus.Published,
          publishedAt: new Date('2026-10-05T09:00:00.000Z'),
          tracksChangedAt: new Date('2026-10-02T09:00:00.000Z'),
        },
        null,
      ),
    ).toBe(false);
  });

  it('is false on anything other than a published release', () => {
    expect(
      hasUnnotedTrackChanges(
        {
          status: StudioReleaseStatus.Draft,
          publishedAt: null,
          tracksChangedAt: new Date('2026-10-02T09:00:00.000Z'),
        },
        null,
      ),
    ).toBe(false);
  });
});

const dispute = (
  overrides: Partial<StudioReleaseDispute> = {},
): StudioReleaseDispute => ({
  id: 'dispute-1',
  releaseId: 'release-1',
  note: 'I hold the rights to every recording',
  status: StudioReleaseDisputeStatus.Open,
  staffReply: null,
  decidedById: null,
  createdAt: new Date('2026-10-12T09:00:00.000Z'),
  decidedAt: null,
  ...overrides,
});

const rejectedDispute = (id: string, day: number): StudioReleaseDispute =>
  dispute({
    id,
    status: StudioReleaseDisputeStatus.Rejected,
    staffReply: 'The label wrote to us',
    createdAt: new Date(Date.UTC(2026, 9, day, 9)),
    decidedAt: new Date(Date.UTC(2026, 9, day, 18)),
  });

describe('Studio dispute fields (open demo pages)', () => {
  const takenDown = (): StudioRelease =>
    release({ status: StudioReleaseStatus.TakenDown });

  it('shows the owner their latest dispute and nobody else any', () => {
    const disputes = [rejectedDispute('dispute-older', 10), dispute()];
    const owner = toStudioReleaseResponse(
      takenDown(),
      persona(),
      [],
      { isOwner: true, isStaff: false },
      disputes,
    );
    expect(owner.dispute).toEqual({
      id: 'dispute-1',
      status: 'open',
      note: 'I hold the rights to every recording',
      staffReply: null,
      createdAt: '2026-10-12T09:00:00.000Z',
      decidedAt: null,
    });
    expect(owner.canDispute).toBe(false);
    for (const viewer of [
      { isOwner: false, isStaff: false },
      { isOwner: false, isStaff: true },
    ]) {
      const response = toStudioReleaseResponse(
        takenDown(),
        persona(),
        [],
        viewer,
        disputes,
      );
      expect(response.dispute).toBeNull();
      expect(response.canDispute).toBe(false);
    }
  });

  it('answers null and false when the caller passes no disputes', () => {
    const listener = toStudioReleaseResponse(release(), persona(), [], {
      isOwner: false,
      isStaff: false,
    });
    expect(listener.dispute).toBeNull();
    expect(listener.canDispute).toBe(false);
  });

  it('lets the owner dispute a taken-down release with no open dispute and fewer than three', () => {
    expect(canFileStudioDispute(takenDown(), [])).toBe(true);
    expect(
      canFileStudioDispute(takenDown(), [rejectedDispute('dispute-1', 10)]),
    ).toBe(true);
    expect(
      canFileStudioDispute(
        release({ status: StudioReleaseStatus.TakenDown, publishedAt: null }),
        [],
      ),
    ).toBe(true);
    expect(
      toStudioReleaseResponse(
        takenDown(),
        persona(),
        [],
        { isOwner: true, isStaff: false },
        [],
      ).canDispute,
    ).toBe(true);
  });

  it('refuses a dispute while one is open, after three, or on a release that is not taken down', () => {
    expect(canFileStudioDispute(takenDown(), [dispute()])).toBe(false);
    expect(
      canFileStudioDispute(takenDown(), [
        rejectedDispute('dispute-1', 8),
        rejectedDispute('dispute-2', 9),
        rejectedDispute('dispute-3', 10),
      ]),
    ).toBe(false);
    expect(canFileStudioDispute(release(), [])).toBe(false);
    expect(
      canFileStudioDispute(release({ status: StudioReleaseStatus.Draft }), []),
    ).toBe(false);
  });

  it('writes a decided dispute with the staff reply and the decision time', () => {
    expect(
      toStudioReleaseDisputeView(rejectedDispute('dispute-2', 11)),
    ).toEqual({
      id: 'dispute-2',
      status: 'rejected',
      note: 'I hold the rights to every recording',
      staffReply: 'The label wrote to us',
      createdAt: '2026-10-11T09:00:00.000Z',
      decidedAt: '2026-10-11T18:00:00.000Z',
    });
  });

  it('carries no staff identity in the owner view', () => {
    const view = toStudioReleaseDisputeView(
      dispute({ decidedById: 'staff-1' }),
    );
    expect(JSON.stringify(view)).not.toContain('staff-1');
  });
});

describe('Studio discovery card fields', () => {
  const scene = (status: StudioSceneState): StudioScene =>
    ({
      id: 'scene-1',
      slug: 'lisbon-ballroom',
      name: 'Lisbon ballroom',
      status,
    }) as StudioScene;

  it('carries the mood and the scene on every release card', () => {
    const card = toStudioReleaseCard(
      release({
        mood: 'late-night',
        sceneId: 'scene-1',
        scene: scene(StudioSceneState.Active),
      }),
      persona(),
      EMPTY_RELEASE_STATS,
    );
    expect(card.mood).toBe('late-night');
    expect(card.scene).toEqual({
      slug: 'lisbon-ballroom',
      name: 'Lisbon ballroom',
    });
  });

  it('reads a stored mood outside the list as null', () => {
    const card = toStudioReleaseCard(
      release({ mood: 'gloomy' }),
      persona(),
      EMPTY_RELEASE_STATS,
    );
    expect(card.mood).toBeNull();
  });

  it('reads an archived scene as null on every card', () => {
    const archived = release({
      sceneId: 'scene-1',
      scene: scene(StudioSceneState.Archived),
    });
    expect(
      toStudioReleaseCard(archived, persona(), EMPTY_RELEASE_STATS).scene,
    ).toBeNull();
    expect(
      toStudioOwnerReleaseCard(archived, persona(), EMPTY_RELEASE_STATS).scene,
    ).toBeNull();
  });

  it('writes null for a release loaded without its scene', () => {
    expect(
      toStudioReleaseCard(release(), persona(), EMPTY_RELEASE_STATS).scene,
    ).toBeNull();
  });

  it('shows the scene id to the owner alone and keeps it while the scene is archived', () => {
    const archived = release({
      sceneId: 'scene-1',
      scene: scene(StudioSceneState.Archived),
    });
    const owner = toStudioReleaseResponse(archived, persona(), [], {
      isOwner: true,
      isStaff: false,
    });
    expect(owner.sceneId).toBe('scene-1');
    expect(owner.scene).toBeNull();
    const listener = toStudioReleaseResponse(archived, persona(), [], {
      isOwner: false,
      isStaff: false,
    });
    expect(listener.sceneId).toBeNull();
    const staff = toStudioReleaseResponse(archived, persona(), [], {
      isOwner: false,
      isStaff: true,
    });
    expect(staff.sceneId).toBeNull();
  });
});

// Studio artist kinds (QUEERPULSE-STUDIO-ARTIST-KINDS-DESIGN-2026-10-14.md).
describe('Studio artist kinds mappers', () => {
  const show = (overrides: Partial<StudioRelease> = {}): StudioRelease =>
    release({ type: StudioReleaseType.Podcast, ...overrides });
  const podcaster = () => persona({ kind: SubprofileKind.Podcaster });
  const episode = (
    id: string,
    position: number,
    publishedAt: Date | null,
    overrides: Partial<StudioTrack> = {},
  ): StudioTrack => track({ id, position, publishedAt, ...overrides });
  const listener = { isOwner: false, isStaff: false };

  it('puts the format of the persona kind on a release card', () => {
    expect(
      toStudioReleaseCard(show(), podcaster(), EMPTY_RELEASE_STATS).format,
    ).toBe('podcast');
    expect(
      toStudioReleaseCard(release(), persona(), EMPTY_RELEASE_STATS).format,
    ).toBe('music');
    expect(
      toStudioReleaseCard(
        release(),
        persona({ kind: SubprofileKind.Writer }),
        EMPTY_RELEASE_STATS,
      ).format,
    ).toBe('music');
  });

  it('adds the format to the artist page header and keeps it off a plain artist reference', () => {
    expect(
      toStudioFormatArtistRef(persona({ kind: SubprofileKind.Drag })),
    ).toEqual(expect.objectContaining({ kind: 'drag', format: 'performance' }));
    expect(Object.keys(toStudioArtistRef(persona()))).not.toContain('format');
  });

  it('hides a draft episode from listeners and numbers episodes by publish order', () => {
    const response = toStudioReleaseResponse(
      show(),
      podcaster(),
      [
        episode('episode-1', 1, new Date('2026-10-02T09:00:00.000Z'), {
          durationSeconds: 100,
        }),
        episode('episode-2', 2, new Date('2026-10-01T09:00:00.000Z'), {
          durationSeconds: 200,
        }),
        episode('episode-3', 3, null, { durationSeconds: 400 }),
      ],
      listener,
    );
    expect(
      response.tracks.map((summary) => [summary.id, summary.position]),
    ).toEqual([
      ['episode-2', 1],
      ['episode-1', 2],
    ]);
    expect(response.tracks.some((summary) => summary.isDraft)).toBe(false);
    expect(response.trackCount).toBe(2);
    expect(response.totalDurationSeconds).toBe(300);
  });

  it('keeps an episode stamped ahead of now away from listeners', () => {
    const response = toStudioReleaseResponse(
      show(),
      podcaster(),
      [
        episode('episode-1', 1, new Date('2026-10-01T09:00:00.000Z')),
        episode('episode-2', 2, new Date(Date.now() + 60_000)),
      ],
      listener,
    );
    expect(response.tracks.map((summary) => summary.id)).toEqual(['episode-1']);
  });

  it('shows the owner every episode at its stored position with the drafts marked', () => {
    const response = toStudioReleaseResponse(
      show(),
      podcaster(),
      [
        episode('episode-1', 1, new Date('2026-10-01T09:00:00.000Z')),
        episode('episode-2', 2, null, {
          audioKey: null,
          durationSeconds: null,
        }),
      ],
      { isOwner: true, isStaff: false },
    );
    expect(
      response.tracks.map((summary) => [
        summary.id,
        summary.position,
        summary.isDraft,
      ]),
    ).toEqual([
      ['episode-1', 1, false],
      ['episode-2', 2, true],
    ]);
    expect(response.trackCount).toBe(2);
  });

  it('marks no draft in the staff view', () => {
    const response = toStudioReleaseResponse(
      show(),
      podcaster(),
      [episode('episode-1', 1, null)],
      { isOwner: false, isStaff: true },
    );
    expect(response.tracks.map((summary) => summary.isDraft)).toEqual([false]);
  });

  it('previews a scheduled show with every episode that has audio', () => {
    const response = toStudioReleaseResponse(
      show({
        status: StudioReleaseStatus.Scheduled,
        publishedAt: null,
        publishAt: new Date('2026-10-20T18:00:00.000Z'),
      }),
      podcaster(),
      [
        episode('episode-1', 1, null),
        episode('episode-2', 2, null, {
          audioKey: null,
          durationSeconds: null,
        }),
      ],
      { isOwner: false, isStaff: false, isPreview: true },
    );
    expect(response.tracks.map((summary) => summary.id)).toEqual(['episode-1']);
  });

  it('leaves music as it was: no draft mark, no publish time, no excerpt', () => {
    const response = toStudioReleaseResponse(
      release(),
      persona(),
      [track({ id: 'track-1', position: 1 })],
      { isOwner: true, isStaff: false },
    );
    expect(response.tracks[0]).toEqual(
      expect.objectContaining({
        isDraft: false,
        publishedAt: null,
        notesExcerpt: null,
      }),
    );
  });

  it('gives a track response its notes, sources, publish time and draft flag', () => {
    const card = toStudioReleaseCard(show(), podcaster(), EMPTY_RELEASE_STATS);
    const draft = toStudioTrackResponse(
      episode('episode-3', 3, null, {
        notes: '00:00 Intro\n\n01:30 Housing',
        sources: [],
      }),
      card,
      [],
      { isOwner: true },
    );
    expect(draft.isDraft).toBe(true);
    expect(draft.notes).toBe('00:00 Intro\n\n01:30 Housing');
    expect(draft.notesExcerpt).toBe('00:00 Intro 01:30 Housing');
    expect(draft.publishedAt).toBeNull();
    expect(draft.sources).toEqual([]);
    const published = toStudioTrackResponse(
      episode('episode-1', 1, new Date('2026-10-01T09:00:00.000Z'), {
        notes: 'Notes',
      }),
      card,
    );
    expect(published.isDraft).toBe(false);
    expect(published.publishedAt).toBe('2026-10-01T09:00:00.000Z');
  });

  it('keeps notes off a track of another type and carries its sources', () => {
    const card = toStudioReleaseCard(
      release({ type: StudioReleaseType.LipSync }),
      persona({ kind: SubprofileKind.Drag }),
      EMPTY_RELEASE_STATS,
    );
    const response = toStudioTrackResponse(
      track({
        notes: 'stray',
        sources: [{ title: 'Rumour Has It', artist: 'Adele' }],
      }),
      card,
      [],
      { isOwner: true },
    );
    expect(response.notes).toBeNull();
    expect(response.sources).toEqual([
      { title: 'Rumour Has It', artist: 'Adele' },
    ]);
    expect(response.isDraft).toBe(false);
  });

  it('plays a published episode with audio and nothing short of that', () => {
    const now = new Date('2026-10-14T12:00:00.000Z');
    const podcastType = { type: StudioReleaseType.Podcast };
    expect(
      isListenerPlayableTrack(
        episode('episode-1', 1, new Date('2026-10-14T11:00:00.000Z')),
        podcastType,
        now,
      ),
    ).toBe(true);
    expect(
      isListenerPlayableTrack(episode('episode-2', 2, null), podcastType, now),
    ).toBe(false);
    expect(
      isListenerPlayableTrack(
        episode('episode-3', 3, new Date('2026-10-14T11:00:00.000Z'), {
          durationSeconds: null,
        }),
        podcastType,
        now,
      ),
    ).toBe(false);
    expect(
      isListenerPlayableTrack(track({}), { type: StudioReleaseType.Mix }, now),
    ).toBe(true);
  });
});

describe('Studio safety on the response mappers', () => {
  const ownerClaim: StudioOwnerClaim = {
    id: 'claim-1',
    trackId: 'track-2',
    status: StudioCopyrightClaimStatus.Accepted,
    originalWork: 'Saudade by Ana Moura',
    originalLink: null,
    details: 'The hook from 0:40',
    claimantRole: StudioClaimantRole.RightsHolder,
    counterNote: null,
    claimantReply: null,
    staffNote: null,
    acceptedAt: '2026-10-14T10:00:00.000Z',
    counteredAt: null,
    decidedAt: null,
    canCounter: true,
  };

  it('serves the artist and staff warnings together on every row, in theme order', () => {
    const summary = toStudioTrackSummary(
      track({
        contentWarnings: ['police'],
        staffContentWarnings: ['medical', 'police'],
      }),
    );
    expect(summary.contentWarnings).toEqual(['medical', 'police']);
    expect(summary.isWithheld).toBe(false);
  });

  it('reads a track written before the safety columns as no warnings', () => {
    const summary = toStudioTrackSummary(track({}));
    expect(summary.contentWarnings).toEqual([]);
    expect(summary.isWithheld).toBe(false);
  });

  it('gives owner rows the two source lists and the lock', () => {
    const response = toStudioReleaseResponse(
      release(),
      persona(),
      [
        track({
          isExplicit: true,
          explicitLockedAt: new Date('2026-10-14T10:00:00.000Z'),
          contentWarnings: ['police'],
          staffContentWarnings: ['medical'],
        }),
      ],
      { isOwner: true, isStaff: false },
    );
    expect(response.tracks[0]).toEqual(
      expect.objectContaining({
        contentWarnings: ['medical', 'police'],
        artistContentWarnings: ['police'],
        staffContentWarnings: ['medical'],
        isExplicitLocked: true,
      }),
    );
  });

  it('redacts a withheld row for listeners and keeps its place', () => {
    const response = toStudioReleaseResponse(
      release(),
      persona(),
      [
        track({ id: 'track-1', position: 1 }),
        track({
          id: 'track-2',
          position: 2,
          title: 'Borrowed',
          isExplicit: true,
          contentWarnings: ['police'],
          notes: 'Sleeve notes',
          withheldAt: new Date('2026-10-14T10:00:00.000Z'),
        }),
        track({ id: 'track-3', position: 3 }),
      ],
      { isOwner: false, isStaff: false },
    );
    expect(response.tracks.map((row) => [row.id, row.position])).toEqual([
      ['track-1', 1],
      ['track-2', 2],
      ['track-3', 3],
    ]);
    expect(response.tracks[1]).toEqual({
      id: 'track-2',
      position: 2,
      title: '',
      durationSeconds: null,
      isExplicit: false,
      hasAudio: false,
      publishedAt: null,
      isDraft: false,
      notesExcerpt: null,
      contentWarnings: [],
      isWithheld: true,
    });
  });

  it('counts a withheld row for listeners and leaves its length out', () => {
    const tracks = [
      track({ id: 'track-1', durationSeconds: 200 }),
      track({
        id: 'track-2',
        position: 2,
        durationSeconds: 300,
        withheldAt: new Date('2026-10-14T10:00:00.000Z'),
      }),
    ];
    expect(listenerStatsForTracks(tracks)).toEqual({
      trackCount: 2,
      totalDurationSeconds: 200,
    });
    const listenerResponse = toStudioReleaseResponse(
      release(),
      persona(),
      tracks,
      { isOwner: false, isStaff: false },
    );
    expect(listenerResponse.trackCount).toBe(2);
    expect(listenerResponse.totalDurationSeconds).toBe(200);
    const ownerResponse = toStudioReleaseResponse(
      release(),
      persona(),
      tracks,
      {
        isOwner: true,
        isStaff: false,
      },
    );
    expect(ownerResponse.totalDurationSeconds).toBe(500);
  });

  it('shows owners and staff the whole withheld row', () => {
    for (const viewer of [
      { isOwner: true, isStaff: false },
      { isOwner: false, isStaff: true },
    ]) {
      const response = toStudioReleaseResponse(
        release(),
        persona(),
        [
          track({
            title: 'Borrowed',
            withheldAt: new Date('2026-10-14T10:00:00.000Z'),
          }),
        ],
        viewer,
      );
      expect(response.tracks[0]).toEqual(
        expect.objectContaining({ title: 'Borrowed', isWithheld: true }),
      );
    }
  });

  it('carries claims to owners only, on the release and the track', () => {
    const tracks = [track({})];
    expect(
      toStudioReleaseResponse(
        release(),
        persona(),
        tracks,
        { isOwner: true, isStaff: false },
        [],
        [],
        undefined,
        [ownerClaim],
      ).claims,
    ).toEqual([ownerClaim]);
    for (const viewer of [
      { isOwner: false, isStaff: false },
      { isOwner: false, isStaff: true },
    ]) {
      expect(
        toStudioReleaseResponse(
          release(),
          persona(),
          tracks,
          viewer,
          [],
          [],
          undefined,
          [ownerClaim],
        ).claims,
      ).toEqual([]);
    }
    const releaseCard = toStudioReleaseCard(
      release(),
      persona(),
      EMPTY_RELEASE_STATS,
    );
    expect(
      toStudioTrackResponse(track({}), releaseCard, [], { isOwner: true }, [
        ownerClaim,
      ]).claims,
    ).toEqual([ownerClaim]);
    expect(
      toStudioTrackResponse(track({}), releaseCard, [], { isOwner: false }, [
        ownerClaim,
      ]).claims,
    ).toEqual([]);
  });
});
