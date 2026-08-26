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
export type BadgeVerification = 'auto' | 'host' | 'review' | 'peer';

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
  /**
   * How the badge is checked, surfaced in the frontend drawer's "how it's
   * checked" copy. Every badge with a `BADGE_REQUIREMENTS` entry (see
   * `recognition.scoring.ts`) is awarded programmatically by `recompute()`,
   * so it's honestly `'auto'` — there is no host-attested, reviewed, or
   * peer-given award path anywhere in this backend yet. Omitted (not
   * defaulted) for a badge with no wired signal, e.g. `founding-member`: we
   * don't yet know how it'll be verified, so we don't claim to.
   */
  verifiedBy?: BadgeVerification;
}

/** A time-limited badge, shown in its own band rather than the main grid.
 *  Content only, like `BADGE_CATALOG` — no award path exists for these yet
 *  (same precedent as `founding-member`: a catalogue entry that isn't
 *  auto-granted). `window` is display text; `opensAt`/`closesAt` are ISO
 *  dates a future awarding pass could gate on. */
export interface SeasonalBadgeCatalogEntry extends BadgeCatalogEntry {
  window: string;
  opensAt: string;
  closesAt: string;
}

export const BADGE_CATALOG: readonly BadgeCatalogEntry[] = [
  {
    key: 'local-scout',
    cat: 'Exploration',
    name: 'Local Scout',
    rarity: 'common',
    tint: 'jade',
    lockedContext: 'Save 3 places in the Local directory',
    earnedContext: 'Saved 3 places in the Local directory',
    verifiedBy: 'auto',
  },
  {
    key: 'well-read',
    cat: 'Culture',
    name: 'Well-Read',
    rarity: 'common',
    tint: 'jade',
    lockedContext: 'Save 5 articles or resources',
    earnedContext: 'Saved 5 articles or resources',
    verifiedBy: 'auto',
  },
  {
    key: 'first-gathering',
    cat: 'Attendance',
    name: 'First Gathering',
    rarity: 'common',
    tint: 'jade',
    lockedContext: 'Attend your first gathering',
    earnedContext: 'Attended a QueerPulse gathering',
    verifiedBy: 'auto',
  },
  {
    key: 'three-company',
    cat: 'Attendance',
    name: "Three's Company",
    rarity: 'common',
    tint: 'jade',
    lockedContext: 'Attend 3 gatherings',
    earnedContext: '3 gatherings attended',
    verifiedBy: 'auto',
  },
  {
    key: 'regular-attendee',
    cat: 'Attendance',
    name: 'Regular',
    rarity: 'rare',
    tint: 'accent',
    lockedContext: 'Attend 5 gatherings in one year',
    earnedContext: '5 gatherings in one year',
    verifiedBy: 'auto',
  },
  {
    key: 'decade',
    cat: 'Platform',
    name: 'Anniversary',
    rarity: 'rare',
    tint: 'jade',
    lockedContext: 'Be a member for 1 year',
    earnedContext: 'Member for 1 year',
    verifiedBy: 'auto',
  },
  {
    key: 'connector',
    cat: 'Community',
    name: 'Connector',
    rarity: 'common',
    tint: 'jade',
    lockedContext: 'Make 10 connections',
    earnedContext: '10 connections made',
    verifiedBy: 'auto',
  },
  {
    key: 'vouch',
    cat: 'Community',
    name: 'Vouch',
    rarity: 'rare',
    tint: 'accent',
    lockedContext: 'Vouch for a new member',
    earnedContext: 'Vouched for a new member',
    verifiedBy: 'auto',
  },
  {
    key: 'thread-starter',
    cat: 'Community',
    name: 'Thread Starter',
    rarity: 'common',
    tint: 'jade',
    lockedContext: 'Start a community thread',
    earnedContext: 'Started a community thread',
    verifiedBy: 'auto',
  },
  {
    key: 'networker',
    cat: 'Community',
    name: 'Networker',
    rarity: 'rare',
    tint: 'plum',
    lockedContext: 'Connect with 50 members',
    earnedContext: 'Connected with 50 members',
    verifiedBy: 'auto',
  },
  {
    key: 'contributor',
    cat: 'Community',
    name: 'Contributor',
    rarity: 'common',
    tint: 'jade',
    lockedContext: 'Submit a member story',
    earnedContext: 'Submitted a member story',
    verifiedBy: 'auto',
  },
  {
    key: 'two-homes',
    cat: 'Community',
    name: 'Two Homes',
    rarity: 'common',
    tint: 'accent',
    lockedContext: 'Join a second community',
    earnedContext: 'Joined a second community',
    verifiedBy: 'auto',
  },
  {
    key: 'founding-member',
    cat: 'Platform',
    name: 'Founding Member',
    rarity: 'legendary',
    tint: 'plum',
    lockedContext: 'Join in the first 500 members',
    earnedContext: 'Joined in the first 500',
    // No signal wired yet (see recognition.scoring.ts) — we don't yet know
    // how this will be verified, so we don't claim to. Also has no
    // `BADGE_REQUIREMENTS` entry, so `buildBadges` (recognition-response.ts)
    // omits it from the locked grid entirely rather than showing "how to
    // earn it" copy for a badge nobody can actually get (COM-14).
  },
  {
    key: 'sustainer',
    cat: 'Platform',
    name: 'Rooted',
    rarity: 'rare',
    tint: 'accent',
    lockedContext: 'Be a member for 6 months',
    earnedContext: 'Member for 6 months',
    verifiedBy: 'auto',
  },
  {
    key: 'work-ready',
    cat: 'Platform',
    name: 'Work Ready',
    rarity: 'rare',
    tint: 'plum',
    lockedContext: 'Fill out your Work Profile (skills and focus areas)',
    earnedContext: 'Completed the Work Profile',
    verifiedBy: 'auto',
  },
  {
    key: 'event-host',
    cat: 'Platform',
    name: 'Event Host',
    rarity: 'legendary',
    tint: 'plum',
    lockedContext: 'Host a QueerPulse gathering',
    earnedContext: 'Hosted a QueerPulse gathering',
    verifiedBy: 'auto',
  },
  {
    key: 'serial-host',
    cat: 'Hosting',
    name: 'Serial Host',
    rarity: 'legendary',
    tint: 'jade',
    lockedContext: 'Host 3 approved gatherings',
    earnedContext: 'Hosted 3 approved gatherings',
    verifiedBy: 'auto',
  },
  {
    key: 'first-steps',
    cat: 'Milestones',
    name: 'First Steps',
    rarity: 'common',
    tint: 'accent',
    lockedContext: 'Finish your getting started checklist',
    earnedContext: 'Completed the getting started checklist',
    verifiedBy: 'auto',
  },
];

/**
 * Time-limited badges (spec-equivalent extension for the v2 Badges & Levels
 * frontend redesign). Purely informational today — no `BADGE_REQUIREMENTS`
 * entry exists for any of these, so `qualifyingBadgeKeys` never grants them
 * (same as `founding-member` above), and `buildSeasonalBadges`
 * (recognition-response.ts) never surfaces them to the frontend either
 * (COM-14) — so the seasonal band doesn't show earning instructions for a
 * badge with no real award path. A future task can wire real signals (e.g.
 * "attended a gathering tagged Pride between opensAt/closesAt") without
 * touching this catalogue's shape; the entry starts appearing the moment it
 * gets a `BADGE_REQUIREMENTS` row.
 */
export const SEASONAL_BADGE_CATALOG: readonly SeasonalBadgeCatalogEntry[] = [
  {
    key: 'pride-2026',
    cat: 'Attendance',
    name: 'Pride 2026',
    rarity: 'rare',
    tint: 'accent',
    lockedContext: 'March with the QueerPulse block',
    earnedContext: 'Marched with the QueerPulse block',
    window: 'Open until 30 June 2026',
    opensAt: '2026-01-01T00:00:00.000Z',
    closesAt: '2026-06-30T23:59:59.000Z',
  },
  {
    key: 'first-table-2026',
    cat: 'Attendance',
    name: 'New Year, First Table',
    rarity: 'common',
    tint: 'jade',
    lockedContext: 'Attend the first gathering of the year',
    earnedContext: 'Attended the first gathering of the year',
    window: 'January only',
    opensAt: '2026-01-01T00:00:00.000Z',
    closesAt: '2026-01-31T23:59:59.000Z',
  },
  {
    key: 'winter-warmth-2026',
    cat: 'Community',
    name: 'Winter Warmth',
    rarity: 'rare',
    tint: 'plum',
    lockedContext: 'Bring someone new to a December gathering',
    earnedContext: 'Brought someone new to a December gathering',
    window: 'Opens 1 December',
    opensAt: '2026-12-01T00:00:00.000Z',
    closesAt: '2026-12-31T23:59:59.000Z',
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
  /**
   * Shown on the perk card. `{base}` and `{total}` are interpolated by
   * `buildPerks` for an invite-quota perk (see `isInviteQuotaPerk`) so the
   * advertised numbers are the enforced ones, read from the same constants.
   */
  desc: string;
  /** Member level (1-indexed, matches `LEVEL_LADDER_DEF`) required to claim. */
  unlockLevel: number;
  availableFooter: PerkAvailableFooter;
  /**
   * Marks a perk whose grant is "more monthly invites". The size of the grant
   * is NOT stored here: it is read from `INVITE_QUOTA_BONUS_BY_LEVEL` using
   * this entry's own `unlockLevel`, so the number on the card and the number
   * `InvitesService.resolveMonthlyLimit` enforces are the same number.
   */
  isInviteQuotaPerk?: boolean;
}

/**
 * The fallback monthly invite allowance, mirroring
 * `app.config.ts`'s `INVITE_MONTHLY_QUOTA` default. Used as the default when
 * a caller has no `ConfigService` handy, so the perk copy never advertises a
 * number the enforcement path would not produce.
 */
export const DEFAULT_INVITE_MONTHLY_QUOTA = 5;

/**
 * Extra monthly invites a member's recognition level grants on top of the
 * configured base quota (`app.inviteMonthlyQuota`).
 *
 * THE SINGLE SOURCE OF TRUTH for the level -> invite-quota relationship.
 * Two things read it and nothing else may hardcode a number:
 *   - `RecognitionEntitlementsService.getInviteQuotaBonus`, which
 *     `InvitesService.resolveMonthlyLimit` adds to the base quota;
 *   - `buildPerks`, which renders the perk copy from it.
 * Before this existed, the catalogue advertised "1 to 2" while the backend
 * enforced a flat 5, so the copy was fiction in both directions (SUS-04).
 */
export const INVITE_QUOTA_BONUS_BY_LEVEL: Readonly<Record<number, number>> = {
  4: 2,
  5: 5,
};

/** The bonus a member at `level` has unlocked: the largest bonus whose level
 *  they have reached, or 0 below the first rung. */
export function inviteQuotaBonusForLevel(level: number): number {
  let bonus = 0;
  for (const [unlockLevel, amount] of Object.entries(
    INVITE_QUOTA_BONUS_BY_LEVEL,
  )) {
    if (level >= Number(unlockLevel)) bonus = Math.max(bonus, amount);
  }
  return bonus;
}

/**
 * PERKS ARE ENFORCED, OR THEY ARE NOT IN THIS LIST (SUS-04).
 *
 * The catalogue used to advertise six perks and enforce none of them: there
 * was no claim endpoint at all (the controller was GET-only), no service read
 * a member's level, and the invite-quota copy named numbers the backend never
 * used. Three entries were deleted rather than faked:
 *
 *   - `early-rsvp` promised a 48-hour head start on RSVPs and an email when a
 *     gathering is approved. There is no RSVP opening window anywhere in
 *     `rsvp.service.ts`, and QueerPulse sends no email at all.
 *   - `trusted-lounge` promised access to a members-only community that does
 *     not exist and that no code path can grant.
 *   - `host-without-approval` promised skipping a host application review.
 *     `POST /events` is guarded by `NotRestrictedGuard` alone and
 *     `EventsService.create` publishes immediately, so there is no review to
 *     skip for anyone, at any level.
 *
 * Every entry below names the file that enforces it.
 */
export const PERK_CATALOG: readonly PerkCatalogEntry[] = [
  {
    // ENFORCED BY: `src/vouch/vouch.controller.ts` — `ActiveMemberGuard` is
    // the only gate on vouching, so every active member really does hold this
    // from day one. Kept at `unlockLevel: 1` so it renders as a capability the
    // member already has rather than a fake locked tier (COM-15).
    key: 'vouch-access',
    cat: 'Community',
    title: 'Vouch access',
    desc: 'The ability to vouch for other members, a trust signal that helps them stand out. Every active member has it from day one.',
    unlockLevel: 1,
    availableFooter: {
      type: 'active-auto',
      autoLabel: 'Available to every active member',
    },
  },
  {
    // ENFORCED BY: `src/membership/invites.service.ts`
    // (`resolveMonthlyLimit`), via
    // `RecognitionEntitlementsService.getInviteQuotaBonus`. The bonus applies
    // once the perk is CLAIMED, which is what the button below writes.
    key: 'invite-quota-level-4',
    cat: 'Membership',
    title: 'More invites each month',
    desc: 'Claim it and your monthly invite allowance goes from {base} to {total}. Invites reset on the first of each month.',
    unlockLevel: 4,
    isInviteQuotaPerk: true,
    availableFooter: {
      type: 'button',
      label: 'Claim the higher allowance',
      toast: 'Claimed. Your monthly invite allowance is higher from now on',
    },
  },
  {
    // ENFORCED BY: `src/membership/invites.service.ts`
    // (`resolveMonthlyLimit`), same path as the Level 4 rung above. Claiming
    // this one replaces the smaller bonus with the larger one.
    key: 'invite-quota-level-5',
    cat: 'Membership',
    title: 'The highest invite allowance',
    desc: 'Claim it and your monthly invite allowance goes from {base} to {total}. The community grows because of people like you.',
    unlockLevel: 5,
    isInviteQuotaPerk: true,
    availableFooter: {
      type: 'button',
      label: 'Claim the higher allowance',
      toast: 'Claimed. Your monthly invite allowance is higher from now on',
    },
  },
];

/** Look up a catalogue entry by its stable key. `undefined` for a key that
 *  is not in the catalogue (a claim request for one is a 404). */
export function perkByKey(key: string): PerkCatalogEntry | undefined {
  return PERK_CATALOG.find((entry) => entry.key === key);
}

/** The invite-quota perks, in catalogue order. The enforcement path
 *  (`RecognitionEntitlementsService`) walks them and keeps the largest bonus
 *  the member has both reached and claimed. */
export const INVITE_QUOTA_PERKS: readonly PerkCatalogEntry[] =
  PERK_CATALOG.filter((entry) => entry.isInviteQuotaPerk === true);

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

/**
 * Baseline capabilities folded into the perks-ladder row for a level,
 * alongside any `PERK_CATALOG` entries unlocking there. Purely descriptive,
 * never individually claimable.
 *
 * Only Level 1 carries entries, and that is the honest shape: nothing in the
 * backend gates messaging, saving, joining a community or hosting a gathering
 * on a recognition level. This map used to place those behind Levels 2 and 3
 * ("Apply to host a gathering" at Level 3), which described a gate no code
 * ever applied (SUS-04). Higher rungs list what the perk catalogue actually
 * grants there, and nothing else.
 */
export const BASE_PERKS_BY_LEVEL: Readonly<Record<number, readonly string[]>> =
  {
    1: [
      'Browse the member directory',
      'Join gatherings & RSVP',
      'Message other members directly',
      'Save articles & resources',
      'Join communities',
      'Host a gathering',
    ],
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
