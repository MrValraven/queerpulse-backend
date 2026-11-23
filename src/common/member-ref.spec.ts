import { In, Repository } from 'typeorm';
import {
  inactiveMemberRef,
  MemberLookup,
  toMemberRef,
  toVisibleAvatarUrl,
} from './member-ref';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { resetImageUrlBaseForTesting, setImageUrlBase } from './image-url';

// A WELL-FORMED storage key: `<prefix>/<owner uuid>/<file uuid><ext>`. Anything
// that does not parse as one is dropped to null by `toImageUrl` (the
// path-traversal boundary in `storage-key.ts`), so a loose stand-in like
// "avatars/a-b/pic.jpg" would make the photoVisible assertions pass or fail for
// the wrong reason.
const AVATAR_KEY =
  'avatars/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.jpg';

beforeEach(() => {
  // A storage key only resolves once the base URL is wired; without it
  // `toImageUrl` throws rather than returning a bare key.
  setImageUrlBase('https://api.test');
});

afterEach(() => {
  resetImageUrlBaseForTesting();
});

// ENG-152. `toVisibleAvatarUrl` is the one spelling of the gate that the
// mappers taking a raw `Profile` (DM author summaries, event attendees and
// organisers, connection cards, the card issuer roster) call directly, so it
// is asserted here rather than only through `toMemberRef`.
describe('toVisibleAvatarUrl', () => {
  it('resolves the avatar when photoVisible is on', () => {
    expect(
      toVisibleAvatarUrl({ avatarUrl: AVATAR_KEY, photoVisible: true }),
    ).toBe(`https://api.test/files/${AVATAR_KEY}`);
  });

  it('returns null when photoVisible is off, even with a stored key', () => {
    expect(
      toVisibleAvatarUrl({ avatarUrl: AVATAR_KEY, photoVisible: false }),
    ).toBeNull();
  });

  it('returns null for an unresolved profile', () => {
    expect(toVisibleAvatarUrl(null)).toBeNull();
    expect(toVisibleAvatarUrl(undefined)).toBeNull();
  });
});

it('maps a profile to a ref and null to null', () => {
  expect(toMemberRef(null)).toBeNull();
  expect(
    toMemberRef({
      slug: 'a-b',
      firstName: 'A',
      lastName: 'B',
      pronouns: 'they/them',
      avatarUrl: null,
      photoVisible: true,
    } as unknown as Profile),
  ).toEqual({
    slug: 'a-b',
    firstName: 'A',
    lastName: 'B',
    pronouns: 'they/them',
    avatarUrl: null,
  });
});

it('exposes the avatar when photoVisible is on (M5)', () => {
  const ref = toMemberRef({
    slug: 'a-b',
    firstName: 'A',
    lastName: 'B',
    pronouns: null,
    avatarUrl: AVATAR_KEY,
    photoVisible: true,
  } as unknown as Profile);
  expect(ref?.avatarUrl).toBe(`https://api.test/files/${AVATAR_KEY}`);
});

it('nulls the avatar when photoVisible is off, regardless of a stored key (M5)', () => {
  const ref = toMemberRef({
    slug: 'a-b',
    firstName: 'A',
    lastName: 'B',
    pronouns: null,
    avatarUrl: AVATAR_KEY,
    photoVisible: false,
  } as unknown as Profile);
  expect(ref?.avatarUrl).toBeNull();
});

// PRD-507. `byUserIds` is where every cross-domain byline is resolved, so it
// is where a paused, suspended or deletion-grace account loses its name.
describe('MemberLookup.byUserIds and inactive accounts', () => {
  interface ProfilesRepositoryStandIn {
    find: jest.Mock;
  }

  const profileRow = (userId: string, status: UserStatus): Profile =>
    Object.assign(new Profile(), {
      userId,
      slug: `${userId}-slug`,
      firstName: `${userId}-first`,
      lastName: 'Last',
      pronouns: null,
      avatarUrl: null,
      photoVisible: true,
      user: Object.assign(new User(), { id: userId, status }),
    });

  const lookupOver = (rows: Profile[]) => {
    const profiles: ProfilesRepositoryStandIn = {
      find: jest.fn().mockResolvedValue(rows),
    };
    return {
      profiles,
      lookup: new MemberLookup(profiles as unknown as Repository<Profile>),
    };
  };

  const rows = [
    profileRow('active-member', UserStatus.Active),
    profileRow('paused-member', UserStatus.Deactivated),
    profileRow('suspended-member', UserStatus.Suspended),
  ];
  const ids = rows.map((row) => row.userId);

  it('loads only the account id and status alongside each profile', async () => {
    const { profiles, lookup } = lookupOver(rows);

    await lookup.byUserIds(ids);

    expect(profiles.find).toHaveBeenCalledWith({
      where: { userId: In(ids) },
      relations: { user: true },
      select: {
        userId: true,
        slug: true,
        firstName: true,
        lastName: true,
        pronouns: true,
        avatarUrl: true,
        photoVisible: true,
        user: { id: true, status: true },
      },
    });
  });

  it('answers an inactive account with the anonymous stand-in by default', async () => {
    const { lookup } = lookupOver(rows);

    const refs = await lookup.byUserIds(ids);

    expect(refs.get('active-member')).toEqual(
      expect.objectContaining({ slug: 'active-member-slug' }),
    );
    expect(refs.get('active-member')?.isInactiveMember).toBeUndefined();
    for (const inactiveId of ['paused-member', 'suspended-member']) {
      expect(refs.get(inactiveId)).toEqual(inactiveMemberRef());
    }
    expect(JSON.stringify([...refs.values()])).not.toContain('paused-member');
    expect(JSON.stringify([...refs.values()])).not.toContain(
      'suspended-member',
    );
  });

  it('leaves an inactive account out of the map when asked to drop it', async () => {
    const { lookup } = lookupOver(rows);

    const refs = await lookup.byUserIds(ids, { inactive: 'drop' });

    expect([...refs.keys()]).toEqual(['active-member']);
  });

  it('keeps the real ref for staff tooling that asks to include it', async () => {
    const { lookup } = lookupOver(rows);

    const refs = await lookup.byUserIds(ids, { inactive: 'include' });

    expect(refs.get('paused-member')).toEqual(
      expect.objectContaining({ slug: 'paused-member-slug' }),
    );
    expect(refs.get('paused-member')?.isInactiveMember).toBeUndefined();
  });

  it('hands out a fresh stand-in for each inactive id', async () => {
    const { lookup } = lookupOver(rows);

    const refs = await lookup.byUserIds(ids);

    expect(refs.get('paused-member')).not.toBe(refs.get('suspended-member'));
  });

  // A `user` that came back without its `status` means the select lost the
  // column, and a lost column hides the member.
  it('treats a loaded user with no status as inactive', async () => {
    const rowWithoutStatus = Object.assign(new Profile(), {
      userId: 'status-lost',
      slug: 'status-lost-slug',
      firstName: 'Status',
      lastName: 'Lost',
      pronouns: null,
      avatarUrl: null,
      photoVisible: true,
      user: Object.assign(new User(), { id: 'status-lost' }),
    });
    const { lookup } = lookupOver([rowWithoutStatus]);

    const refs = await lookup.byUserIds(['status-lost']);

    expect(refs.get('status-lost')).toEqual(inactiveMemberRef());
  });

  // The only row that reads as active without a status is one whose `user`
  // relation is absent altogether, which a real read never returns (the
  // join is on the primary key). It exists for bare stand-in rows in specs.
  it('reads a row with no user relation at all as active', async () => {
    const bareRow = Object.assign(new Profile(), {
      userId: 'bare-row',
      slug: 'bare-row-slug',
      firstName: 'Bare',
      lastName: 'Row',
      pronouns: null,
      avatarUrl: null,
      photoVisible: true,
    });
    const { lookup } = lookupOver([bareRow]);

    const refs = await lookup.byUserIds(['bare-row']);

    expect(refs.get('bare-row')).toEqual(
      expect.objectContaining({ slug: 'bare-row-slug' }),
    );
  });
});
