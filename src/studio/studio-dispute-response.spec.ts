import {
  StudioReleaseDispute,
  StudioReleaseDisputeStatus,
} from './entities/studio-release-dispute.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import {
  toStudioAdminDispute,
  toStudioAdminReleaseSummary,
} from './studio-dispute-response';
import { StudioArtistPersona } from './studio-response';

const persona = {
  id: 'persona-1',
  handle: 'night-shift',
  displayName: 'Night Shift',
  kind: 'dj',
  avatarUrl: null,
} as StudioArtistPersona;

const release = (overrides: Partial<StudioRelease> = {}): StudioRelease =>
  ({
    id: 'release-1',
    subprofileId: 'persona-1',
    title: 'Lisbon at four',
    type: StudioReleaseType.Mix,
    description: null,
    genre: 'electronic',
    coverKey: null,
    releasedOn: '2026-10-01',
    status: StudioReleaseStatus.TakenDown,
    publishedAt: new Date('2026-10-01T09:00:00.000Z'),
    rightsConfirmedAt: new Date('2026-09-30T09:00:00.000Z'),
    takenDownAt: new Date('2026-10-12T08:00:00.000Z'),
    takenDownById: 'staff-1',
    takedownReason: 'Uploaded without the rights',
    ...overrides,
  }) as StudioRelease;

describe('Studio staff dispute mappers', () => {
  it('summarises a release with its takedown facts and the persona name', () => {
    const summary = toStudioAdminReleaseSummary(release(), persona, {
      trackCount: 2,
      totalDurationSeconds: 400,
    });
    expect(summary).toEqual(
      expect.objectContaining({
        id: 'release-1',
        title: 'Lisbon at four',
        trackCount: 2,
        totalDurationSeconds: 400,
        status: 'taken_down',
        takedownReason: 'Uploaded without the rights',
        takenDownAt: '2026-10-12T08:00:00.000Z',
      }),
    );
    expect(summary.artist.name).toBe('Night Shift');
  });

  it('leaves out who took the release down and who owns the persona', () => {
    const serialized = JSON.stringify(
      toStudioAdminReleaseSummary(release(), persona, {
        trackCount: 0,
        totalDurationSeconds: 0,
      }),
    );
    expect(serialized).not.toContain('staff-1');
    expect(serialized).not.toContain('userId');
  });

  it('reads a release that is not taken down with null takedown facts', () => {
    const summary = toStudioAdminReleaseSummary(
      release({
        status: StudioReleaseStatus.Published,
        takenDownAt: null,
        takenDownById: null,
        takedownReason: null,
      }),
      persona,
      { trackCount: 1, totalDurationSeconds: 200 },
    );
    expect(summary.takenDownAt).toBeNull();
    expect(summary.takedownReason).toBeNull();
    expect(summary.status).toBe('published');
  });

  it('carries the dispute and its release and leaves the deciding staff member out', () => {
    const summary = toStudioAdminReleaseSummary(release(), persona, {
      trackCount: 2,
      totalDurationSeconds: 400,
    });
    const decided = {
      id: 'dispute-1',
      releaseId: 'release-1',
      note: 'I hold the rights to every recording',
      status: StudioReleaseDisputeStatus.Upheld,
      staffReply: 'Thanks, the licence checks out',
      decidedById: 'staff-2',
      createdAt: new Date('2026-10-12T09:00:00.000Z'),
      decidedAt: new Date('2026-10-12T18:00:00.000Z'),
    } as StudioReleaseDispute;

    const adminDispute = toStudioAdminDispute(decided, summary);

    expect(adminDispute).toEqual({
      id: 'dispute-1',
      status: 'upheld',
      note: 'I hold the rights to every recording',
      staffReply: 'Thanks, the licence checks out',
      createdAt: '2026-10-12T09:00:00.000Z',
      decidedAt: '2026-10-12T18:00:00.000Z',
      release: summary,
    });
    expect(JSON.stringify(adminDispute)).not.toContain('staff-2');
  });
});
