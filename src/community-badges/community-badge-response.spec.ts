import type { MemberRef } from '../common/member-ref';
import {
  NO_COMMUNITY_NAME_MARKS,
  nameMarksFor,
  toCommunityBadgeAdminDTO,
  toCommunityBadgeDTO,
  toCommunityFlairDTO,
  toCommunityGiftAllowanceDTO,
  toCommunityMemberGiftDTO,
  toCommunitySentGiftDTO,
  toCommunityShelfGiftDTO,
  type CommunityNameMarks,
} from './community-badge-response';
import { CommunityBadgeRuleType } from './community-badges.catalog';
import { CommunityBadge } from './entities/community-badge.entity';
import { CommunityGift } from './entities/community-gift.entity';

const RECIPIENT: MemberRef = {
  slug: 'ana-silva',
  firstName: 'Ana',
  lastName: 'Silva',
  pronouns: null,
  avatarUrl: null,
};

function makeBadge(overrides: Partial<CommunityBadge> = {}): CommunityBadge {
  return Object.assign(new CommunityBadge(), {
    id: 'badge-1',
    communityId: 'community-1',
    starterKey: 'regular',
    name: 'Regular',
    iconKey: 'calendar',
    tint: 'jade',
    ruleType: CommunityBadgeRuleType.EventsCheckedIn,
    threshold: 3,
    isEnabled: true,
    createdById: null,
    backfillRequestedAt: null,
    createdAt: new Date('2026-11-01T08:00:00.000Z'),
    updatedAt: new Date('2026-11-02T09:00:00.000Z'),
    ...overrides,
  });
}

function makeGift(overrides: Partial<CommunityGift> = {}): CommunityGift {
  return Object.assign(new CommunityGift(), {
    id: 'gift-1',
    communityId: 'community-1',
    senderId: 'sender-1',
    recipientId: 'recipient-1',
    giftKey: 'heart',
    note: 'thank you',
    sentAt: new Date('2026-11-20T10:00:00.000Z'),
    hiddenByRecipientAt: null,
    removedAt: null,
    removedById: null,
    ...overrides,
  });
}

describe('community badge response mappers', () => {
  it('maps a member badge with progress and earned date and leaves server fields out', () => {
    const dto = toCommunityBadgeDTO(
      makeBadge({ backfillRequestedAt: new Date(), createdById: 'u1' }),
      2,
      new Date('2026-11-20T10:00:00.000Z'),
    );
    expect(dto).toEqual({
      id: 'badge-1',
      name: 'Regular',
      starterKey: 'regular',
      iconKey: 'calendar',
      tint: 'jade',
      ruleType: 'events_checked_in',
      threshold: 3,
      progress: 2,
      earnedAt: '2026-11-20T10:00:00.000Z',
    });
  });

  it('maps a visitor badge with null progress and no earned date', () => {
    const dto = toCommunityBadgeDTO(makeBadge(), null, null);
    expect(dto.progress).toBeNull();
    expect(dto.earnedAt).toBeNull();
  });

  it('maps a badge to flair with the four display fields only', () => {
    expect(toCommunityFlairDTO(makeBadge())).toEqual({
      name: 'Regular',
      starterKey: 'regular',
      iconKey: 'calendar',
      tint: 'jade',
    });
  });

  it('maps an admin badge with its holder count', () => {
    expect(Object.keys(toCommunityBadgeAdminDTO(makeBadge(), 4))).toEqual([
      'id',
      'starterKey',
      'name',
      'iconKey',
      'tint',
      'ruleType',
      'threshold',
      'isEnabled',
      'holderCount',
      'createdAt',
      'updatedAt',
    ]);
    const dto = toCommunityBadgeAdminDTO(makeBadge({ isEnabled: false }), 4);
    expect(dto.holderCount).toBe(4);
    expect(dto.isEnabled).toBe(false);
    expect(dto.createdAt).toBe('2026-11-01T08:00:00.000Z');
    expect(dto.updatedAt).toBe('2026-11-02T09:00:00.000Z');
  });

  it('resets the allowance 7 days after the oldest counted gift', () => {
    expect(
      toCommunityGiftAllowanceDTO(3, new Date('2026-11-20T10:00:00.000Z')),
    ).toEqual({
      limit: 10,
      used: 3,
      remaining: 7,
      resetsAt: '2026-11-27T10:00:00.000Z',
    });
    expect(toCommunityGiftAllowanceDTO(0, null)).toEqual({
      limit: 10,
      used: 0,
      remaining: 10,
      resetsAt: null,
    });
    expect(
      toCommunityGiftAllowanceDTO(12, new Date('2026-11-20T10:00:00.000Z'))
        .remaining,
    ).toBe(0);
  });

  it('maps a sent gift with the recipient and the allowance', () => {
    const allowance = toCommunityGiftAllowanceDTO(
      1,
      new Date('2026-11-20T10:00:00.000Z'),
    );
    expect(toCommunitySentGiftDTO(makeGift(), RECIPIENT, allowance)).toEqual({
      id: 'gift-1',
      giftKey: 'heart',
      note: 'thank you',
      recipient: RECIPIENT,
      sentAt: '2026-11-20T10:00:00.000Z',
      allowance,
    });
  });

  it('shows the shelf gift with its mark end and hidden flag', () => {
    const dto = toCommunityShelfGiftDTO(
      makeGift({ hiddenByRecipientAt: new Date('2026-11-21T00:00:00.000Z') }),
      null,
    );
    expect(dto).toEqual({
      id: 'gift-1',
      giftKey: 'heart',
      note: 'thank you',
      sender: null,
      sentAt: '2026-11-20T10:00:00.000Z',
      markEndsAt: '2026-11-27T10:00:00.000Z',
      isHidden: true,
    });
  });

  it('shows a visible shelf gift as not hidden', () => {
    expect(toCommunityShelfGiftDTO(makeGift(), RECIPIENT).isHidden).toBe(false);
  });

  it('keeps sender and note off a member gift mark', () => {
    expect(toCommunityMemberGiftDTO(makeGift(), false)).toEqual({
      id: 'gift-1',
      giftKey: 'heart',
      sentAt: '2026-11-20T10:00:00.000Z',
      canRemove: false,
    });
  });

  it('falls back to no marks for an unknown or null user', () => {
    expect(nameMarksFor(new Map(), null)).toBe(NO_COMMUNITY_NAME_MARKS);
    expect(nameMarksFor(new Map(), 'u1')).toEqual({
      flair: null,
      hasRecentGift: false,
    });
  });

  it('returns the stored marks for a known user', () => {
    const marks: CommunityNameMarks = {
      flair: toCommunityFlairDTO(makeBadge()),
      hasRecentGift: true,
    };
    expect(nameMarksFor(new Map([['u1', marks]]), 'u1')).toBe(marks);
  });

  it('freezes the shared empty marks', () => {
    expect(Object.isFrozen(NO_COMMUNITY_NAME_MARKS)).toBe(true);
  });
});
