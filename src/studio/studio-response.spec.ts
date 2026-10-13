import {
  StudioRelease,
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import {
  EMPTY_RELEASE_STATS,
  StudioArtistPersona,
  statsForTracks,
  toStudioArtistRef,
  toStudioOwnerReleaseCard,
  toStudioReleaseCard,
  toStudioReleaseResponse,
} from './studio-response';

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

  it('orders tracks by position and marks the ones without audio', () => {
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
      { isOwner: false, isStaff: false },
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
});
