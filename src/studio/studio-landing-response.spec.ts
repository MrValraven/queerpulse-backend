import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import {
  AdminLandingPreviewRow,
  markPreviewsOnLanding,
  toAdminStudioLandingPreview,
} from './admin-studio-landing-response';
import {
  AccessRequestRow,
  OwnerPreviewRow,
  StudioLandingPreviewOwnerItem,
  decodeAccessRequestCursor,
  encodeAccessRequestCursor,
  landingPersonaColumnsSql,
  toAdminStudioAccessRequest,
  toStudioLandingCounts,
  toStudioLandingPersona,
  toStudioLandingPreviewOwnerItem,
} from './studio-landing-response';

const REQUEST_ID = '6f1f0a52-3c1d-4f6e-9a55-0d8f6f0b9a11';
const API_BASE_URL = 'https://api.example.test';
const PERSONA_AVATAR_KEY =
  'persona/0b6a3a8e-79d4-4a1c-8d8e-6a77d2b0c001/0b6a3a8e-79d4-4a1c-8d8e-6a77d2b0c002.jpg';
const MEMBER_AVATAR_KEY =
  'avatars/0b6a3a8e-79d4-4a1c-8d8e-6a77d2b0c003/0b6a3a8e-79d4-4a1c-8d8e-6a77d2b0c004.jpg';

beforeAll(() => {
  setImageUrlBase(API_BASE_URL);
});

afterAll(() => {
  resetImageUrlBaseForTesting();
});

function ownerRow(
  overrides: Partial<OwnerPreviewRow> &
    Pick<OwnerPreviewRow, 'relation' | 'status'>,
): OwnerPreviewRow {
  return {
    id: 'preview-1',
    track_id: 'track-1',
    track_title: 'Night Drive',
    track_duration_seconds: 187,
    release_id: 'release-1',
    release_title: 'Night Drive EP',
    release_cover_key: null,
    main_artist_id: 'persona-1',
    main_artist_handle: 'nova',
    main_artist_display_name: 'Nova',
    main_artist_kind: 'musician',
    main_artist_avatar_url: null,
    requested_at: new Date('2026-10-20T10:00:00.000Z'),
    decided_at: null,
    is_eligible: true,
    ...overrides,
  };
}

function actionsOf(item: StudioLandingPreviewOwnerItem): boolean[] {
  return [item.canApprove, item.canDecline, item.canWithdraw];
}

function adminPreviewRow(
  overrides: Partial<AdminLandingPreviewRow>,
): AdminLandingPreviewRow {
  return {
    id: 'preview-1',
    status: 'approved',
    position: 1,
    track_id: 'track-1',
    track_title: 'Night Drive',
    track_duration_seconds: 187,
    release_id: 'release-1',
    release_title: 'Night Drive EP',
    release_cover_key: null,
    artist_id: 'persona-1',
    artist_handle: 'nova',
    artist_display_name: 'Nova',
    artist_kind: 'musician',
    artist_avatar_url: null,
    ineligible_reason: null,
    requested_by_id: null,
    requested_at: new Date('2026-10-20T10:00:00.000Z'),
    decided_by_id: null,
    decided_at: null,
    ...overrides,
  };
}

function onLandingRow(
  id: string,
  status: string,
  ineligibleReason: string | null,
): { id: string; status: string; ineligible_reason: string | null } {
  return { id, status, ineligible_reason: ineligibleReason };
}

describe('studio landing response shapes', () => {
  it('floors each count below five to null and keeps five', () => {
    expect(
      toStudioLandingCounts({
        artists: '4',
        releases: 5,
        events_this_month: 0,
      }),
    ).toEqual({ artists: null, releases: 5, eventsThisMonth: null });
  });

  it('reads a numeric string count of twelve as twelve', () => {
    expect(
      toStudioLandingCounts({
        artists: '12',
        releases: '5',
        events_this_month: '7',
      }),
    ).toEqual({ artists: 12, releases: 5, eventsThisMonth: 7 });
  });

  it('reads a stored kind outside the artist kinds as the fallback kind', () => {
    const persona = toStudioLandingPersona(
      {
        artist_handle: 'nova',
        artist_display_name: 'Nova',
        artist_kind: 'venue',
        artist_avatar_url: null,
        artist_link_visibility: 'linked',
      },
      'artist',
    );
    expect(persona.kind).toBe('musician');
  });

  it('serves a linked avatar and reads an unlinked member key as null', () => {
    const linked = toStudioLandingPersona(
      {
        artist_handle: 'nova',
        artist_display_name: 'Nova',
        artist_kind: 'dj',
        artist_avatar_url: MEMBER_AVATAR_KEY,
        artist_link_visibility: 'linked',
      },
      'artist',
    );
    const unlinkedMemberKey = toStudioLandingPersona(
      {
        artist_handle: 'nova',
        artist_display_name: 'Nova',
        artist_kind: 'dj',
        artist_avatar_url: MEMBER_AVATAR_KEY,
        artist_link_visibility: 'unlinked',
      },
      'artist',
    );
    const unlinkedPersonaKey = toStudioLandingPersona(
      {
        artist_handle: 'nova',
        artist_display_name: 'Nova',
        artist_kind: 'dj',
        artist_avatar_url: PERSONA_AVATAR_KEY,
        artist_link_visibility: 'unlinked',
      },
      'artist',
    );
    expect([
      linked.avatarUrl?.startsWith(API_BASE_URL),
      unlinkedMemberKey.avatarUrl,
      unlinkedPersonaKey.avatarUrl?.startsWith(API_BASE_URL),
    ]).toEqual([true, null, true]);
  });

  it('selects the five public persona columns and no id', () => {
    const sql = landingPersonaColumnsSql('persona', 'artist');
    expect(
      ['_handle', '_display_name', '_kind', '_avatar_url', '_link_visibility']
        .map((suffix) => sql.includes(`AS "artist${suffix}"`))
        .concat(sql.includes('"id"')),
    ).toEqual([true, true, true, true, true, false]);
  });

  it('derives the owner actions from relation and status', () => {
    expect(
      actionsOf(
        toStudioLandingPreviewOwnerItem(
          ownerRow({ relation: 'main', status: 'pending' }),
        ),
      ),
    ).toEqual([true, true, false]);
    expect(
      actionsOf(
        toStudioLandingPreviewOwnerItem(
          ownerRow({ relation: 'credited', status: 'pending' }),
        ),
      ),
    ).toEqual([false, false, false]);
    expect(
      actionsOf(
        toStudioLandingPreviewOwnerItem(
          ownerRow({ relation: 'credited', status: 'approved' }),
        ),
      ),
    ).toEqual([false, false, true]);
  });

  it('round-trips a waiting list cursor and reads garbage as the first page', () => {
    const cursor = {
      wantsToRelease: true,
      createdAt: new Date('2026-10-28T09:00:00.123Z'),
      id: REQUEST_ID,
    };
    const encoded = encodeAccessRequestCursor(cursor);
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).toBe(
      `1|2026-10-28T09:00:00.123Z|${REQUEST_ID}`,
    );
    expect([
      decodeAccessRequestCursor(encoded),
      decodeAccessRequestCursor('garbage'),
      decodeAccessRequestCursor(undefined),
    ]).toEqual([cursor, null, null]);
  });

  it('marks the first five approved eligible open rows as on the landing', () => {
    const rows = [
      onLandingRow('a', 'approved', null),
      onLandingRow('b', 'pending', null),
      onLandingRow('c', 'approved', 'content_warnings'),
      onLandingRow('d', 'approved', null),
      onLandingRow('e', 'approved', null),
      onLandingRow('f', 'approved', null),
      onLandingRow('g', 'approved', null),
      onLandingRow('h', 'approved', null),
    ];
    expect([...markPreviewsOnLanding(rows)]).toEqual(['a', 'd', 'e', 'f', 'g']);
  });

  it('shows a staff ref by the batched name and null for a deleted staff member', () => {
    const userNames = new Map<string, string>([['staff-1', 'Ana Silva']]);
    const preview = toAdminStudioLandingPreview(
      adminPreviewRow({
        requested_by_id: 'staff-1',
        decided_by_id: 'staff-deleted',
        decided_at: new Date('2026-10-21T10:00:00.000Z'),
      }),
      userNames,
      true,
    );
    expect([
      preview.requestedBy,
      preview.decidedBy,
      preview.isOnLanding,
    ]).toEqual([{ id: 'staff-1', displayName: 'Ana Silva' }, null, true]);
  });

  it('reads an unknown stored ineligible reason as null and keeps a known one', () => {
    const known = toAdminStudioLandingPreview(
      adminPreviewRow({ ineligible_reason: 'open_claim' }),
      new Map<string, string>(),
      false,
    );
    const unknown = toAdminStudioLandingPreview(
      adminPreviewRow({ ineligible_reason: 'something_else' }),
      new Map<string, string>(),
      false,
    );
    expect([known.ineligibleReason, unknown.ineligibleReason]).toEqual([
      'open_claim',
      null,
    ]);
  });

  it('shows a waiting member by full name and a member without a profile with an empty slug', () => {
    const row: AccessRequestRow = {
      id: REQUEST_ID,
      user_id: 'user-1',
      wants_to_release: true,
      is_from_invite: false,
      created_at: new Date('2026-10-28T09:00:00.123Z'),
    };
    const withProfile = toAdminStudioAccessRequest(row, {
      slug: 'ana-silva',
      firstName: 'Ana',
      lastName: 'Silva',
      pronouns: null,
      avatarUrl: null,
    });
    const withoutProfile = toAdminStudioAccessRequest(row, null);
    expect([
      withProfile.member,
      withoutProfile.member.slug,
      withProfile.requestedAt,
    ]).toEqual([
      {
        id: 'user-1',
        slug: 'ana-silva',
        displayName: 'Ana Silva',
        avatarUrl: null,
      },
      '',
      '2026-10-28T09:00:00.123Z',
    ]);
  });
});
