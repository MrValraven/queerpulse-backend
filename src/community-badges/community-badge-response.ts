// Wire types and hand-written mappers for community badges, gifts and flair.
// Nothing about a member's earned set, progress or shelf leaves through any
// DTO but the two member-only reads (the badge list and the gift shelf).
import type { MemberRef } from '../common/member-ref';
import {
  COMMUNITY_GIFT_WEEKLY_LIMIT,
  COMMUNITY_GIFT_WINDOW_DAYS,
  type CommunityBadgeRuleType,
  type CommunityBadgeStarterKey,
} from './community-badges.catalog';
import type { CommunityBadge } from './entities/community-badge.entity';
import type { CommunityGift } from './entities/community-gift.entity';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** The worn badge as other viewers see it next to a name. */
export interface CommunityFlairDTO {
  name: string;
  starterKey: CommunityBadgeStarterKey | null;
  iconKey: string;
  tint: string;
}

/** One enabled badge in the member and visitor view. */
export interface CommunityBadgeDTO {
  id: string;
  name: string;
  starterKey: CommunityBadgeStarterKey | null;
  iconKey: string;
  tint: string;
  ruleType: CommunityBadgeRuleType;
  threshold: number;
  /** The viewer's current count, uncapped; null for non-members. */
  progress: number | null;
  /** Null when not earned or for non-members. */
  earnedAt: string | null;
}

/** Response of the member and visitor badge list. */
export interface CommunityBadgesResponse {
  isMember: boolean;
  /** Null for non-members, none worn, or a worn badge that is disabled. */
  wornBadgeId: string | null;
  /** Enabled badges only, created_at ASC, id ASC. */
  badges: CommunityBadgeDTO[];
}

/** One badge in the staff view. */
export interface CommunityBadgeAdminDTO {
  id: string;
  starterKey: CommunityBadgeStarterKey | null;
  name: string;
  iconKey: string;
  tint: string;
  ruleType: CommunityBadgeRuleType;
  threshold: number;
  isEnabled: boolean;
  /** Live count of award holders currently on the roster. */
  holderCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Response of the staff badge list. */
export interface CommunityBadgeAdminResponse {
  /** The caller is owner-level. */
  canManage: boolean;
  limit: number;
  /** All badges, enabled or not, in the same order as the member list. */
  badges: CommunityBadgeAdminDTO[];
}

/** The sender's weekly gift allowance in one community. */
export interface CommunityGiftAllowanceDTO {
  limit: number;
  /** Gifts this caller sent here in the last 7 days, removed ones included. */
  used: number;
  remaining: number;
  /** The oldest counted gift's sentAt plus 7 days; null when used is 0. */
  resetsAt: string | null;
}

/** Echo of a gift the caller just sent. */
export interface CommunitySentGiftDTO {
  id: string;
  giftKey: string;
  note: string | null;
  recipient: MemberRef;
  sentAt: string;
  allowance: CommunityGiftAllowanceDTO;
}

/** One gift on the recipient's own shelf. */
export interface CommunityShelfGiftDTO {
  id: string;
  giftKey: string;
  note: string | null;
  /** Null for an erased account, shown as a deleted member. */
  sender: MemberRef | null;
  sentAt: string;
  /** The end of the gift mark: sentAt plus 7 days. */
  markEndsAt: string;
  isHidden: boolean;
}

/** One visible gift mark, readable by anyone who can read the community. */
export interface CommunityMemberGiftDTO {
  id: string;
  giftKey: string;
  sentAt: string;
  /** The caller is the sender or owner-level. */
  canRemove: boolean;
}

/** Response of the worn-badge write. */
export interface CommunityFlairResponse {
  wornBadgeId: string | null;
  flair: CommunityFlairDTO | null;
}

/** The two marks shown beside a member's name in one community. */
export interface CommunityNameMarks {
  flair: CommunityFlairDTO | null;
  hasRecentGift: boolean;
}

/** The marks of a member with no flair and no recent gift. */
export const NO_COMMUNITY_NAME_MARKS: CommunityNameMarks = Object.freeze({
  flair: null,
  hasRecentGift: false,
});

/** Look up a user's marks in a batched map, falling back to no marks for a
 * null or unknown user id. */
export function nameMarksFor(
  marksByUserId: ReadonlyMap<string, CommunityNameMarks>,
  userId: string | null,
): CommunityNameMarks {
  if (userId === null) {
    return NO_COMMUNITY_NAME_MARKS;
  }
  return marksByUserId.get(userId) ?? NO_COMMUNITY_NAME_MARKS;
}

/** Map a badge to the flair shown beside a name. */
export function toCommunityFlairDTO(
  badge: Pick<CommunityBadge, 'name' | 'starterKey' | 'iconKey' | 'tint'>,
): CommunityFlairDTO {
  return {
    name: badge.name,
    starterKey: badge.starterKey,
    iconKey: badge.iconKey,
    tint: badge.tint,
  };
}

/** Map a badge to the member and visitor view, with the viewer's progress and
 * earned date (both null for a non-member). */
export function toCommunityBadgeDTO(
  badge: CommunityBadge,
  progress: number | null,
  awardedAt: Date | null,
): CommunityBadgeDTO {
  return {
    id: badge.id,
    name: badge.name,
    starterKey: badge.starterKey,
    iconKey: badge.iconKey,
    tint: badge.tint,
    ruleType: badge.ruleType,
    threshold: badge.threshold,
    progress,
    earnedAt: awardedAt ? awardedAt.toISOString() : null,
  };
}

/** Map a badge to the staff view with its live holder count. */
export function toCommunityBadgeAdminDTO(
  badge: CommunityBadge,
  holderCount: number,
): CommunityBadgeAdminDTO {
  return {
    id: badge.id,
    starterKey: badge.starterKey,
    name: badge.name,
    iconKey: badge.iconKey,
    tint: badge.tint,
    ruleType: badge.ruleType,
    threshold: badge.threshold,
    isEnabled: badge.isEnabled,
    holderCount,
    createdAt: badge.createdAt.toISOString(),
    updatedAt: badge.updatedAt.toISOString(),
  };
}

/** Build the sender's allowance from the count of gifts in the window and the
 * sentAt of the oldest one counted. */
export function toCommunityGiftAllowanceDTO(
  used: number,
  oldestCountedSentAt: Date | null,
): CommunityGiftAllowanceDTO {
  const hasCountedGift = used > 0 && oldestCountedSentAt !== null;
  return {
    limit: COMMUNITY_GIFT_WEEKLY_LIMIT,
    used,
    remaining: Math.max(0, COMMUNITY_GIFT_WEEKLY_LIMIT - used),
    resetsAt: hasCountedGift
      ? new Date(
          oldestCountedSentAt.getTime() +
            COMMUNITY_GIFT_WINDOW_DAYS * MILLISECONDS_PER_DAY,
        ).toISOString()
      : null,
  };
}

/** Map a gift the caller just sent, with the recipient and the new allowance. */
export function toCommunitySentGiftDTO(
  gift: CommunityGift,
  recipient: MemberRef,
  allowance: CommunityGiftAllowanceDTO,
): CommunitySentGiftDTO {
  return {
    id: gift.id,
    giftKey: gift.giftKey,
    note: gift.note,
    recipient,
    sentAt: gift.sentAt.toISOString(),
    allowance,
  };
}

/** Map a gift for the recipient's own shelf. */
export function toCommunityShelfGiftDTO(
  gift: CommunityGift,
  sender: MemberRef | null,
): CommunityShelfGiftDTO {
  return {
    id: gift.id,
    giftKey: gift.giftKey,
    note: gift.note,
    sender,
    sentAt: gift.sentAt.toISOString(),
    markEndsAt: new Date(
      gift.sentAt.getTime() + COMMUNITY_GIFT_WINDOW_DAYS * MILLISECONDS_PER_DAY,
    ).toISOString(),
    isHidden: gift.hiddenByRecipientAt !== null,
  };
}

/** Map a visible gift mark. The sender and the note stay off this shape. */
export function toCommunityMemberGiftDTO(
  gift: Pick<CommunityGift, 'id' | 'giftKey' | 'sentAt'>,
  canRemove: boolean,
): CommunityMemberGiftDTO {
  return {
    id: gift.id,
    giftKey: gift.giftKey,
    sentAt: gift.sentAt.toISOString(),
    canRemove,
  };
}
