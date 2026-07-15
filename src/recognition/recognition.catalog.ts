/**
 * Static gamification content for `recognition` (spec §3 Tier 2). The level
 * ladder, badge catalogue and perk catalogue are *content*, not per-user
 * data — they live in code (like the Tier 5 CMS modules seed from FE mock
 * data) rather than in the database, so the ladder can be rebalanced or the
 * catalogue extended without a migration. Only per-user *state* (XP total,
 * which badges/perks a member has earned or claimed) is persisted — see
 * `entities/`.
 *
 * Badge/perk copy loosely mirrors the frontend's demo data
 * (`queerpulse/src/features/members/badges.data.tsx`,
 * `perks.data.ts`) so the catalogue reads naturally once wired to real
 * awarding logic in a later task — exact wording is not a contract; only the
 * response *shape* (`recognition.api.ts`) is.
 */

export type BadgeRarity = 'common' | 'rare' | 'legendary';
export type BadgeTint = 'jade' | 'accent' | 'plum';

export interface BadgeCatalogEntry {
  /** Stable slug the frontend maps to an icon (see `badgeIcons.tsx`). */
  key: string;
  cat: string;
  name: string;
  rarity: BadgeRarity;
  tint: BadgeTint;
  /** Shown while locked: how to earn it. */
  lockedContext: string;
  /** Shown once earned, when no per-award `context` was recorded. */
  earnedContext: string;
}

export const BADGE_CATALOG: readonly BadgeCatalogEntry[] = [
  {
    key: 'first-gathering',
    cat: 'Attendance',
    name: 'First Gathering',
    rarity: 'common',
    tint: 'jade',
    lockedContext: 'Attend your first gathering',
    earnedContext: 'Attended a QueerPulse gathering',
  },
  {
    key: 'three-company',
    cat: 'Attendance',
    name: "Three's Company",
    rarity: 'common',
    tint: 'jade',
    lockedContext: 'Attend 3 gatherings',
    earnedContext: '3 gatherings attended',
  },
  {
    key: 'regular-attendee',
    cat: 'Attendance',
    name: 'Regular',
    rarity: 'rare',
    tint: 'accent',
    lockedContext: 'Attend 5 gatherings in one year',
    earnedContext: '5 gatherings in one year',
  },
  {
    key: 'decade',
    cat: 'Attendance',
    name: 'Decade',
    rarity: 'rare',
    tint: 'jade',
    lockedContext: 'Attend 10 gatherings',
    earnedContext: '10 gatherings attended',
  },
  {
    key: 'connector',
    cat: 'Community',
    name: 'Connector',
    rarity: 'common',
    tint: 'jade',
    lockedContext: 'Make 10 connections',
    earnedContext: '10 connections made',
  },
  {
    key: 'vouch',
    cat: 'Community',
    name: 'Vouch',
    rarity: 'rare',
    tint: 'accent',
    lockedContext: 'Vouch for a new member',
    earnedContext: 'Vouched for a new member',
  },
  {
    key: 'thread-starter',
    cat: 'Community',
    name: 'Thread Starter',
    rarity: 'common',
    tint: 'jade',
    lockedContext: 'Start a community thread',
    earnedContext: 'Started a community thread',
  },
  {
    key: 'networker',
    cat: 'Community',
    name: 'Networker',
    rarity: 'rare',
    tint: 'plum',
    lockedContext: 'Connect with 50 members',
    earnedContext: 'Connected with 50 members',
  },
  {
    key: 'contributor',
    cat: 'Community',
    name: 'Contributor',
    rarity: 'common',
    tint: 'jade',
    lockedContext: 'Submit a member story',
    earnedContext: 'Submitted a member story',
  },
  {
    key: 'founding-member',
    cat: 'Platform',
    name: 'Founding Member',
    rarity: 'legendary',
    tint: 'plum',
    lockedContext: 'Join in the first 500 members',
    earnedContext: 'Joined in the first 500',
  },
  {
    key: 'sustainer',
    cat: 'Platform',
    name: 'Sustainer',
    rarity: 'rare',
    tint: 'accent',
    lockedContext: 'Be a supporting member for 6 months',
    earnedContext: 'Supporting member · 6 months',
  },
  {
    key: 'event-host',
    cat: 'Platform',
    name: 'Event Host',
    rarity: 'legendary',
    tint: 'plum',
    lockedContext: 'Host a QueerPulse gathering',
    earnedContext: 'Hosted a QueerPulse gathering',
  },
  {
    key: 'serial-host',
    cat: 'Hosting',
    name: 'Serial Host',
    rarity: 'legendary',
    tint: 'jade',
    lockedContext: 'Host 3 approved gatherings',
    earnedContext: 'Hosted 3 approved gatherings',
  },
];

/** XP-only footer variants a perk can carry while it's still claimable
 *  ('lock' and 'claimed' are computed per-user, never stored on the
 *  catalogue). */
export type PerkAvailableFooter =
  | { type: 'active-auto'; autoLabel: string }
  | { type: 'button'; label: string; toast: string }
  | { type: 'link-auto'; label: string; to: string; autoLabel: string };

export interface PerkCatalogEntry {
  key: string;
  cat: string;
  title: string;
  desc: string;
  /** Member level (1-indexed, matches `LEVEL_LADDER_DEF`) required to claim. */
  unlockLevel: number;
  availableFooter: PerkAvailableFooter;
}

export const PERK_CATALOG: readonly PerkCatalogEntry[] = [
  {
    key: 'vouch-access',
    cat: 'Community',
    title: 'Vouch access',
    desc: 'The ability to vouch for new members on the waitlist.',
    unlockLevel: 3,
    availableFooter: {
      type: 'active-auto',
      autoLabel: 'Applied automatically at Level 3 · Regular',
    },
  },
  {
    key: 'early-rsvp',
    cat: 'Early Access',
    title: 'Early RSVP Access',
    desc: "Get 48-hour early access to all new gathering RSVPs before they open to the community. You'll receive an email the moment a new gathering is approved.",
    unlockLevel: 4,
    availableFooter: {
      type: 'active-auto',
      autoLabel: 'Applied automatically at Level 4',
    },
  },
  {
    key: 'trusted-lounge',
    cat: 'Community',
    title: 'Trusted Lounge',
    desc: 'Access to the Trusted members-only community — a smaller, quieter space to connect. Not indexed or visible to the general directory.',
    unlockLevel: 4,
    availableFooter: {
      type: 'button',
      label: 'Join the lounge',
      toast: 'Welcome to the Trusted Lounge',
    },
  },
  {
    key: 'invite-quota-2',
    cat: 'Membership',
    title: 'Increased Invite Quota',
    desc: 'Your monthly invite allowance increases from 1 to 2.',
    unlockLevel: 4,
    availableFooter: {
      type: 'link-auto',
      label: 'Send an invite',
      to: '/auth/invite',
      autoLabel: 'Requires action',
    },
  },
  {
    key: 'host-without-approval',
    cat: 'Hosting',
    title: 'Host without approval',
    desc: "Skip the host application review — your gatherings go live immediately. You've earned the trust.",
    unlockLevel: 5,
    availableFooter: {
      type: 'active-auto',
      autoLabel: 'Applied automatically at Level 5 · Trusted',
    },
  },
  {
    key: 'invite-quota-3',
    cat: 'Membership',
    title: 'Invite quota increases to 3',
    desc: 'Bring even more people in. Your monthly quota goes to 3 invites.',
    unlockLevel: 5,
    availableFooter: {
      type: 'active-auto',
      autoLabel: 'Applied automatically at Level 5 · Trusted',
    },
  },
];

export interface LevelDef {
  /** 1-indexed level number. */
  level: number;
  name: string;
  /** XP needed to complete this level and advance; `null` marks the max
   *  level (no further span, no next level). */
  xpSpan: number | null;
}

export const LEVEL_LADDER_DEF: readonly LevelDef[] = [
  { level: 1, name: 'Newcomer', xpSpan: 200 },
  { level: 2, name: 'Explorer', xpSpan: 300 },
  { level: 3, name: 'Regular', xpSpan: 450 },
  { level: 4, name: 'Familiar', xpSpan: 650 },
  { level: 5, name: 'Trusted', xpSpan: 900 },
  { level: 6, name: 'Anchor', xpSpan: 1200 },
  { level: 7, name: 'Pillar', xpSpan: null },
];

/** Baseline perks every member already has at a given level, folded into
 *  the perks-ladder row alongside any `PERK_CATALOG` entries unlocking at
 *  that level. Purely descriptive — not individually claimable. */
export const BASE_PERKS_BY_LEVEL: Readonly<Record<number, readonly string[]>> =
  {
    1: [
      'Browse the member directory',
      'Join gatherings & RSVP',
      'Access the resource library',
    ],
    2: [
      'Message other members directly',
      'Save articles & resources',
      'Join communities',
    ],
    3: ['Apply to host a gathering'],
  };

export function levelDefByNumber(level: number): LevelDef | undefined {
  return LEVEL_LADDER_DEF.find((def) => def.level === level);
}

export function levelName(level: number): string {
  return levelDefByNumber(level)?.name ?? 'Unknown';
}

/** Cumulative XP required to reach the *start* of `level` (level 1 starts
 *  at 0 XP). */
export function levelStartXp(level: number): number {
  let total = 0;
  for (const def of LEVEL_LADDER_DEF) {
    if (def.level === level) return total;
    total += def.xpSpan ?? 0;
  }
  return total;
}
