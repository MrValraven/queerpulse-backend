/**
 * A frozen copy of the four starter badges of the community badges contract,
 * section 2, written on 2026-11-23. It seeds AddCommunityBadges1840700000000.
 * Do not edit: the values are plain strings so a later edit to
 * `src/community-badges/community-badges.catalog.ts` never changes what this
 * migration wrote. Owners rename, retune or delete their starters on the
 * community badges page once the migration has run.
 */
export interface CommunityBadgeStarterSeed {
  starterKey: string;
  name: string;
  ruleType: string;
  threshold: number;
  iconKey: string;
  tint: string;
}

/** The four starters in contract order; the array index is the seed position. */
export const COMMUNITY_BADGE_STARTER_SEEDS_1840700000000: readonly CommunityBadgeStarterSeed[] =
  [
    {
      starterKey: 'regular',
      name: 'Regular',
      ruleType: 'events_checked_in',
      threshold: 3,
      iconKey: 'calendar',
      tint: 'jade',
    },
    {
      starterKey: 'old_friend',
      name: 'Old friend',
      ruleType: 'tenure_days',
      threshold: 365,
      iconKey: 'clock',
      tint: 'plum',
    },
    {
      starterKey: 'helping_hands',
      name: 'Helping hands',
      ruleType: 'volunteer_hours',
      threshold: 5,
      iconKey: 'life_buoy',
      tint: 'amber',
    },
    {
      starterKey: 'in_the_conversation',
      name: 'In the conversation',
      ruleType: 'posts_and_replies',
      threshold: 10,
      iconKey: 'message_circle',
      tint: 'accent',
    },
  ];
