import { Profile } from '../users/entities/profile.entity';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { SubprofileMember } from './entities/subprofile-member.entity';
import {
  SubprofileInvite,
  SubprofileInviteStatus,
} from './entities/subprofile-invite.entity';
import { toInviteView, toMemberView } from './subprofile-invite-response';

// ENG-452: `toMemberView`/`toInviteView` used to send `profile.avatarUrl`
// straight through `toImageUrl`, ignoring the member's own `photoVisible`
// toggle. A co-owner or invitee who hid their photo still had it appear on
// the persona's members/invites roster. Both now route through
// `toVisibleAvatarUrl` (`common/member-ref.ts`), the one spelling of that
// gate every cross-domain member view uses.

// A WELL-FORMED storage key (mirrors `common/member-ref.spec.ts`'s fixture):
// `<prefix>/<owner uuid>/<file uuid><ext>`. A loose stand-in like
// "avatars/alex.jpg" would make the photoVisible assertions pass or fail for
// the wrong reason (`toImageUrl` drops anything that doesn't parse as one).
const AVATAR_KEY =
  'avatars/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.jpg';

beforeEach(() => {
  // `toImageUrl` requires the base URL to be wired before it can resolve a
  // storage key into a URL, so this sets it up for every test below.
  setImageUrlBase('https://api.test');
});

afterEach(() => {
  resetImageUrlBaseForTesting();
});

function buildProfile(overrides: Partial<Profile> = {}): Profile {
  return Object.assign(new Profile(), {
    userId: 'member-1',
    firstName: 'Alex',
    lastName: 'Reyes',
    slug: 'alex-reyes',
    avatarUrl: AVATAR_KEY,
    photoVisible: true,
    ...overrides,
  });
}

describe('toMemberView', () => {
  it('resolves avatarUrl when the co-owner shows their photo', () => {
    const member = Object.assign(new SubprofileMember(), {
      userId: 'member-1',
      joinedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const view = toMemberView(member, buildProfile(), 'creator-1');
    expect(view.avatarUrl).toBe(`https://api.test/files/${AVATAR_KEY}`);
  });

  it('hides avatarUrl when the co-owner has turned their photo off', () => {
    const member = Object.assign(new SubprofileMember(), {
      userId: 'member-1',
      joinedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const view = toMemberView(
      member,
      buildProfile({ photoVisible: false }),
      'creator-1',
    );
    expect(view.avatarUrl).toBeNull();
  });
});

describe('toInviteView', () => {
  const invite = Object.assign(new SubprofileInvite(), {
    id: 'invite-1',
    subprofileId: 'sp-1',
    invitedUserId: 'member-1',
    invitedByUserId: 'creator-1',
    status: SubprofileInviteStatus.Pending,
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
  });

  it('resolves invitedAvatarUrl when the invitee shows their photo', () => {
    const view = toInviteView(invite, buildProfile());
    expect(view.invitedAvatarUrl).toBe(`https://api.test/files/${AVATAR_KEY}`);
  });

  it('hides invitedAvatarUrl when the invitee has turned their photo off', () => {
    const view = toInviteView(invite, buildProfile({ photoVisible: false }));
    expect(view.invitedAvatarUrl).toBeNull();
  });
});
