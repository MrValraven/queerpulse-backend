import { toMemberRef, toVisibleAvatarUrl } from './member-ref';
import { Profile } from '../users/entities/profile.entity';
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
