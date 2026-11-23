/** Most badges one top-level community can hold. */
export const COMMUNITY_BADGE_LIMIT = 12;
/** Longest badge name, in code points after sanitising and trimming. */
export const COMMUNITY_BADGE_NAME_MAX_LENGTH = 32;
/** Longest gift note, in code points after sanitising and trimming. */
export const COMMUNITY_GIFT_NOTE_MAX_LENGTH = 140;
/** Gifts one sender may send in one community inside the window. */
export const COMMUNITY_GIFT_WEEKLY_LIMIT = 10;
/** Days the weekly cap and the recent-gift mark both look back. */
export const COMMUNITY_GIFT_WINDOW_DAYS = 7;

/** What a badge counts toward its threshold. */
export enum CommunityBadgeRuleType {
  TenureDays = 'tenure_days',
  EventsCheckedIn = 'events_checked_in',
  VolunteerHours = 'volunteer_hours',
  PostsAndReplies = 'posts_and_replies',
}

/** The 24 icons a badge or gift can use, in the contract's table order. */
export const COMMUNITY_BADGE_ICON_KEYS = [
  'award',
  'music',
  'compass',
  'star',
  'headphones',
  'map_pin',
  'heart',
  'mic',
  'flag',
  'sun',
  'book_open',
  'calendar',
  'moon',
  'camera',
  'clock',
  'zap',
  'film',
  'users',
  'feather',
  'pen_tool',
  'message_circle',
  'coffee',
  'smile',
  'life_buoy',
] as const;

/** One of the 24 badge icon keys. */
export type CommunityBadgeIconKey = (typeof COMMUNITY_BADGE_ICON_KEYS)[number];

/** The six flair tints, each backed by a hue token on the frontend. */
export const COMMUNITY_FLAIR_TINTS = [
  'jade',
  'accent',
  'plum',
  'rose',
  'amber',
  'violet',
] as const;

/** One of the six flair tints. */
export type CommunityFlairTint = (typeof COMMUNITY_FLAIR_TINTS)[number];

/** The inclusive threshold range each rule allows. */
export const COMMUNITY_BADGE_RULES: Record<
  CommunityBadgeRuleType,
  { min: number; max: number }
> = {
  [CommunityBadgeRuleType.TenureDays]: { min: 30, max: 3650 },
  [CommunityBadgeRuleType.EventsCheckedIn]: { min: 1, max: 500 },
  [CommunityBadgeRuleType.VolunteerHours]: { min: 1, max: 1000 },
  [CommunityBadgeRuleType.PostsAndReplies]: { min: 1, max: 5000 },
};

/** The four starter badge keys seeded into every top-level community. */
export const COMMUNITY_BADGE_STARTER_KEYS = [
  'regular',
  'old_friend',
  'helping_hands',
  'in_the_conversation',
] as const;

/** One of the four starter badge keys. */
export type CommunityBadgeStarterKey =
  (typeof COMMUNITY_BADGE_STARTER_KEYS)[number];

/** The starter badges, in the order the seed inserts them. */
export const COMMUNITY_BADGE_STARTERS: readonly {
  starterKey: CommunityBadgeStarterKey;
  name: string;
  ruleType: CommunityBadgeRuleType;
  threshold: number;
  iconKey: CommunityBadgeIconKey;
  tint: CommunityFlairTint;
}[] = [
  {
    starterKey: 'regular',
    name: 'Regular',
    ruleType: CommunityBadgeRuleType.EventsCheckedIn,
    threshold: 3,
    iconKey: 'calendar',
    tint: 'jade',
  },
  {
    starterKey: 'old_friend',
    name: 'Old friend',
    ruleType: CommunityBadgeRuleType.TenureDays,
    threshold: 365,
    iconKey: 'clock',
    tint: 'plum',
  },
  {
    starterKey: 'helping_hands',
    name: 'Helping hands',
    ruleType: CommunityBadgeRuleType.VolunteerHours,
    threshold: 5,
    iconKey: 'life_buoy',
    tint: 'amber',
  },
  {
    starterKey: 'in_the_conversation',
    name: 'In the conversation',
    ruleType: CommunityBadgeRuleType.PostsAndReplies,
    threshold: 10,
    iconKey: 'message_circle',
    tint: 'accent',
  },
];

/** The eight gifts staff can send. */
export const COMMUNITY_GIFT_KEYS = [
  'heart',
  'star',
  'coffee',
  'feather',
  'sun',
  'life_buoy',
  'music',
  'smile',
] as const;

/** One of the eight gift keys. */
export type CommunityGiftKey = (typeof COMMUNITY_GIFT_KEYS)[number];

/** Each gift with the badge icon and tint that draw it. */
export const COMMUNITY_GIFTS: readonly {
  key: CommunityGiftKey;
  iconKey: CommunityBadgeIconKey;
  tint: CommunityFlairTint;
}[] = [
  { key: 'heart', iconKey: 'heart', tint: 'rose' },
  { key: 'star', iconKey: 'star', tint: 'amber' },
  { key: 'coffee', iconKey: 'coffee', tint: 'accent' },
  { key: 'feather', iconKey: 'feather', tint: 'violet' },
  { key: 'sun', iconKey: 'sun', tint: 'amber' },
  { key: 'life_buoy', iconKey: 'life_buoy', tint: 'jade' },
  { key: 'music', iconKey: 'music', tint: 'plum' },
  { key: 'smile', iconKey: 'smile', tint: 'jade' },
];

/** Whether a value is one of the badge icon keys. */
export function isCommunityBadgeIconKey(
  value: unknown,
): value is CommunityBadgeIconKey {
  return (COMMUNITY_BADGE_ICON_KEYS as readonly unknown[]).includes(value);
}

/** Whether a value is one of the flair tints. */
export function isCommunityFlairTint(
  value: unknown,
): value is CommunityFlairTint {
  return (COMMUNITY_FLAIR_TINTS as readonly unknown[]).includes(value);
}

/** Whether a value is one of the badge rule types. */
export function isCommunityBadgeRuleType(
  value: unknown,
): value is CommunityBadgeRuleType {
  return (Object.values(CommunityBadgeRuleType) as unknown[]).includes(value);
}

/** Whether a value is one of the gift keys. */
export function isCommunityGiftKey(value: unknown): value is CommunityGiftKey {
  return (COMMUNITY_GIFT_KEYS as readonly unknown[]).includes(value);
}

/** Length in code points, so an emoji counts as one character. */
export function codePointLength(value: string): number {
  return [...value].length;
}
