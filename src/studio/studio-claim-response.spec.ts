import {
  StudioClaimantRole,
  StudioCopyrightClaim,
  StudioCopyrightClaimStatus,
} from './entities/studio-copyright-claim.entity';
import { StudioTrack } from './entities/studio-track.entity';
import {
  toStudioAdminClaim,
  toStudioAdminTrack,
  toStudioMyClaim,
  toStudioOwnerClaim,
} from './studio-claim-response';
import { StudioAdminReleaseSummary } from './studio-dispute-response';
import { StudioArtistPersona } from './studio-response';

const CLAIM_ID = 'c8000000-0000-4000-8000-000000000001';
const TRACK_ID = 'c8100000-0000-4000-8000-000000000001';
const RELEASE_ID = 'c8200000-0000-4000-8000-000000000001';
const CLAIMANT_ID = 'c8300000-0000-4000-8000-000000000001';
const STAFF_ID = 'c8300000-0000-4000-8000-000000000002';

const claim = (
  overrides: Partial<StudioCopyrightClaim> = {},
): StudioCopyrightClaim => ({
  id: CLAIM_ID,
  trackId: TRACK_ID,
  releaseId: RELEASE_ID,
  claimantId: CLAIMANT_ID,
  claimantRole: StudioClaimantRole.RightsHolder,
  originalWork: 'Saudade by Ana Moura',
  originalLink: 'https://example.test/saudade',
  details: 'The hook from 0:40 is lifted whole',
  goodFaithAt: new Date('2026-10-14T09:00:00.000Z'),
  status: StudioCopyrightClaimStatus.Accepted,
  counterNote: null,
  counteredAt: null,
  claimantReply: null,
  repliedAt: null,
  staffNote: null,
  decidedById: STAFF_ID,
  acceptedAt: new Date('2026-10-14T10:00:00.000Z'),
  decidedAt: null,
  trackTitleAtFiling: 'Opening at filing',
  artistNameAtFiling: 'Night Shift at filing',
  isSevered: false,
  createdAt: new Date('2026-10-14T09:00:00.000Z'),
  updatedAt: new Date('2026-10-14T10:00:00.000Z'),
  ...overrides,
});

const persona = {
  id: 'c8400000-0000-4000-8000-000000000001',
  handle: 'night-shift',
  displayName: 'Night Shift',
  kind: 'dj',
  avatarUrl: null,
} as StudioArtistPersona;

const releaseSummary = {
  id: RELEASE_ID,
  title: 'Lisbon at four',
} as StudioAdminReleaseSummary;

describe('Studio claim mappers', () => {
  it('names no claimant on the owner view', () => {
    const ownerClaim = toStudioOwnerClaim(claim());
    expect(Object.keys(ownerClaim).sort()).toEqual([
      'acceptedAt',
      'canCounter',
      'claimantReply',
      'claimantRole',
      'counterNote',
      'counteredAt',
      'decidedAt',
      'details',
      'id',
      'originalLink',
      'originalWork',
      'staffNote',
      'status',
      'trackId',
    ]);
    expect(JSON.stringify(ownerClaim)).not.toContain(CLAIMANT_ID);
    expect(JSON.stringify(ownerClaim)).not.toContain(STAFF_ID);
  });

  it('lets an owner counter an accepted claim once', () => {
    expect(toStudioOwnerClaim(claim()).canCounter).toBe(true);
    const countered = toStudioOwnerClaim(
      claim({
        status: StudioCopyrightClaimStatus.Countered,
        counterNote: 'I wrote every bar',
        counteredAt: new Date('2026-10-14T11:00:00.000Z'),
      }),
    );
    expect(countered).toEqual(
      expect.objectContaining({
        status: 'countered',
        counterNote: 'I wrote every bar',
        counteredAt: '2026-10-14T11:00:00.000Z',
        acceptedAt: '2026-10-14T10:00:00.000Z',
        canCounter: false,
      }),
    );
  });

  it('gives the claimant the track, release and artist, with their flags', () => {
    const myClaim = toStudioMyClaim(
      claim({
        status: StudioCopyrightClaimStatus.Countered,
        counterNote: 'I wrote every bar',
        counteredAt: new Date('2026-10-14T11:00:00.000Z'),
      }),
      {
        track: { id: TRACK_ID, title: 'Opening' },
        release: { id: RELEASE_ID, title: 'Lisbon at four' },
        persona,
      },
    );
    expect(myClaim).toEqual({
      id: CLAIM_ID,
      status: 'countered',
      claimantRole: 'rights_holder',
      originalWork: 'Saudade by Ana Moura',
      originalLink: 'https://example.test/saudade',
      details: 'The hook from 0:40 is lifted whole',
      counterNote: 'I wrote every bar',
      claimantReply: null,
      staffNote: null,
      createdAt: '2026-10-14T09:00:00.000Z',
      acceptedAt: '2026-10-14T10:00:00.000Z',
      counteredAt: '2026-10-14T11:00:00.000Z',
      repliedAt: null,
      decidedAt: null,
      canReply: true,
      canWithdraw: true,
      track: {
        id: TRACK_ID,
        title: 'Opening',
        release: { id: RELEASE_ID, title: 'Lisbon at four' },
        artist: {
          id: persona.id,
          handle: 'night-shift',
          name: 'Night Shift',
          kind: 'dj',
          avatarUrl: null,
        },
        artistName: 'Night Shift',
      },
    });
  });

  it('gives the claimant only the names kept at filing once the claim is severed', () => {
    const myClaim = toStudioMyClaim(claim({ isSevered: true }), {
      track: { id: TRACK_ID, title: 'Opening' },
      release: { id: RELEASE_ID, title: 'Lisbon at four' },
      persona,
    });
    expect(myClaim.track).toEqual({
      id: null,
      title: 'Opening at filing',
      release: { id: null, title: null },
      artist: null,
      artistName: 'Night Shift at filing',
    });
    const serialized = JSON.stringify(myClaim);
    expect(serialized).not.toContain(TRACK_ID);
    expect(serialized).not.toContain(RELEASE_ID);
    expect(serialized).not.toContain(persona.id);
    expect(serialized).not.toContain('night-shift');
    expect(myClaim.id).toBe(CLAIM_ID);
    expect(myClaim.canWithdraw).toBe(true);
  });

  it('answers from the names kept at filing when no live context is given', () => {
    expect(toStudioMyClaim(claim(), null).track).toEqual({
      id: null,
      title: 'Opening at filing',
      release: { id: null, title: null },
      artist: null,
      artistName: 'Night Shift at filing',
    });
  });

  it('closes the flags on a decided claim', () => {
    const myClaim = toStudioMyClaim(
      claim({
        status: StudioCopyrightClaimStatus.Upheld,
        staffNote: 'The licence covers the sample',
        decidedAt: new Date('2026-10-15T09:00:00.000Z'),
      }),
      {
        track: { id: TRACK_ID, title: 'Opening' },
        release: { id: RELEASE_ID, title: 'Lisbon at four' },
        persona,
      },
    );
    expect(myClaim.canReply).toBe(false);
    expect(myClaim.canWithdraw).toBe(false);
    expect(myClaim.staffNote).toBe('The licence covers the sample');
    expect(myClaim.decidedAt).toBe('2026-10-15T09:00:00.000Z');
  });

  it('shows staff the claimant and the track position and state', () => {
    const adminClaim = toStudioAdminClaim(claim(), {
      track: {
        id: TRACK_ID,
        title: 'Opening',
        position: 2,
        withheldAt: new Date('2026-10-14T10:00:00.000Z'),
      },
      release: releaseSummary,
      claimant: {
        id: CLAIMANT_ID,
        slug: 'ana',
        displayName: 'Ana Silva',
        avatarUrl: null,
      },
    });
    expect(adminClaim.claimant).toEqual({
      id: CLAIMANT_ID,
      slug: 'ana',
      displayName: 'Ana Silva',
      avatarUrl: null,
    });
    expect(adminClaim.track).toEqual({
      id: TRACK_ID,
      title: 'Opening',
      position: 2,
      isWithheld: true,
    });
    expect(adminClaim.release).toBe(releaseSummary);
    expect(adminClaim).not.toHaveProperty('decidedById');
  });

  it('gives staff both warning lists, the union and the lock of a track', () => {
    const adminTrack = toStudioAdminTrack(
      {
        id: TRACK_ID,
        releaseId: RELEASE_ID,
        position: 1,
        title: 'Opening',
        audioKey: 'studio-audio/a/b.mp3',
        durationSeconds: 200,
        isExplicit: true,
        explicitLockedAt: new Date('2026-10-14T10:00:00.000Z'),
        contentWarnings: ['police', 'medical'],
        staffContentWarnings: ['medical', 'self-harm'],
        withheldAt: null,
      } as StudioTrack,
      releaseSummary,
    );
    expect(adminTrack).toEqual({
      id: TRACK_ID,
      releaseId: RELEASE_ID,
      position: 1,
      title: 'Opening',
      durationSeconds: 200,
      hasAudio: true,
      isExplicit: true,
      isExplicitLocked: true,
      contentWarnings: ['medical', 'self-harm', 'police'],
      artistContentWarnings: ['medical', 'police'],
      staffContentWarnings: ['medical', 'self-harm'],
      isWithheld: false,
      release: releaseSummary,
    });
  });
});
