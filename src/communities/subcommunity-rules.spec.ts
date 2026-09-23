import { AccessTier } from './entities/community.entity';
import { RosterRole } from './entities/community-member.entity';
import {
  isTierAtLeastAsStrict,
  resolveEffectiveRole,
} from './subcommunity-rules';

describe('isTierAtLeastAsStrict', () => {
  it('accepts the same tier', () => {
    expect(isTierAtLeastAsStrict(AccessTier.Request, AccessTier.Request)).toBe(
      true,
    );
  });
  it('accepts a stricter child', () => {
    expect(isTierAtLeastAsStrict(AccessTier.Private, AccessTier.Public)).toBe(
      true,
    );
  });
  it('rejects a more open child', () => {
    expect(isTierAtLeastAsStrict(AccessTier.Public, AccessTier.Request)).toBe(
      false,
    );
    expect(isTierAtLeastAsStrict(AccessTier.Invite, AccessTier.Private)).toBe(
      false,
    );
  });
});

describe('resolveEffectiveRole', () => {
  it('returns the own role for a top-level community', () => {
    expect(
      resolveEffectiveRole({
        isSpace: false,
        ownRole: RosterRole.Mod,
        parentRole: null,
      }),
    ).toBe(RosterRole.Mod);
  });
  it('returns null in a space without a parent roster row, even with a space row', () => {
    expect(
      resolveEffectiveRole({
        isSpace: true,
        ownRole: RosterRole.Member,
        parentRole: null,
      }),
    ).toBeNull();
  });
  it('gives a parent mod mod powers in a space they never joined', () => {
    expect(
      resolveEffectiveRole({
        isSpace: true,
        ownRole: null,
        parentRole: RosterRole.Mod,
      }),
    ).toBe(RosterRole.Mod);
  });
  it('maps a parent owner to co_owner in the space', () => {
    expect(
      resolveEffectiveRole({
        isSpace: true,
        ownRole: null,
        parentRole: RosterRole.Owner,
      }),
    ).toBe(RosterRole.CoOwner);
  });
  it('keeps the higher of own and inherited role', () => {
    expect(
      resolveEffectiveRole({
        isSpace: true,
        ownRole: RosterRole.Owner,
        parentRole: RosterRole.Mod,
      }),
    ).toBe(RosterRole.Owner);
  });
  it('gives a plain parent member nothing beyond their own space role', () => {
    expect(
      resolveEffectiveRole({
        isSpace: true,
        ownRole: null,
        parentRole: RosterRole.Member,
      }),
    ).toBeNull();
    expect(
      resolveEffectiveRole({
        isSpace: true,
        ownRole: RosterRole.Member,
        parentRole: RosterRole.Member,
      }),
    ).toBe(RosterRole.Member);
  });
});
