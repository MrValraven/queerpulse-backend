import {
  BADGE_CATALOG,
  BASE_PERKS_BY_LEVEL,
  BadgeRarity,
  BadgeTint,
  BadgeVerification,
  DEFAULT_INVITE_MONTHLY_QUOTA,
  LEVEL_LADDER_DEF,
  PERK_CATALOG,
  PerkCatalogEntry,
  SEASONAL_BADGE_CATALOG,
  inviteQuotaBonusForLevel,
  levelName,
  levelStartXp,
} from './recognition.catalog';
import {
  BADGE_REQUIREMENTS,
  badgeBonusFor,
  badgeBonusXp,
  badgeProgress,
  RecognitionSignals,
  xpBreakdown,
} from './recognition.scoring';

/**
 * Response shapes matched exactly to the frontend's
 * `queerpulse/src/features/members/api/recognition.api.ts` (`RecognitionDTO`
 * and its nested types) — the canonical contract for
 * `GET /me/recognition` / `GET /profiles/:slug/recognition`.
 */

export interface LevelDTO {
  level: number;
  name: string;
  xp: number;
  xpMax: number;
  /** 0..100 progress toward the next level. */
  percent: number;
  xpToNext: number;
  /** Next level's name, or null at max level. */
  nextName: string | null;
}

export type LadderState = 'done' | 'current' | 'locked';
export interface LevelLadderRowDTO {
  num: number;
  name: string;
  state: LadderState;
}

export interface BadgeDTO {
  key: string;
  cat: string;
  name: string;
  context: string;
  rarity: BadgeRarity;
  tint: BadgeTint;
  /** XP awarded once earned, derived from rarity (`BADGE_BONUS_BY_RARITY`). */
  xpReward?: number;
  /** Omitted (not defaulted) when no `BADGE_REQUIREMENTS` entry exists. */
  verifiedBy?: BadgeVerification;
  /** Locked badges only, and only when signals are available (owner view). */
  progress?: { units: number; target: number };
  /** Present only for time-limited badges (see `SEASONAL_BADGE_CATALOG`). */
  seasonal?: { when: string };
  /** Owner view only, and only when true: the member has hidden this badge
   *  from how other people see them. Another member's view never carries the
   *  field because the badge itself is omitted from that response. */
  hiddenFromProfile?: boolean;
}
export interface BadgesDTO {
  earnedCount: number;
  discoverCount: number;
  earned: BadgeDTO[];
  locked: BadgeDTO[];
  /** Time-limited badges, shown in their own band. */
  seasonal: BadgeDTO[];
}

export type PerkState = 'available' | 'locked' | 'claimed';
export type PerkFooterDTO =
  | { type: 'active-auto'; autoLabel: string }
  | { type: 'button'; label: string; toast: string }
  | { type: 'link-auto'; label: string; to: string; autoLabel: string }
  | { type: 'lock'; label: string }
  | { type: 'claimed'; date: string };
export interface PerkDTO {
  /** Stable catalogue key, and the path segment
   *  `POST /me/recognition/perks/:key/claim` takes. */
  key: string;
  cat: string;
  title: string;
  desc: string;
  state: PerkState;
  footer: PerkFooterDTO;
}
export interface PerkGroupDTO {
  label: string;
  perks: PerkDTO[];
}

export type PerkLadderState = 'achieved' | 'current' | 'locked';
export interface PerkLadderRowDTO {
  num: number;
  name: string;
  state: PerkLadderState;
  status: string;
  perks: string[];
}
export interface PerksDTO {
  availableCount: number;
  groups: PerkGroupDTO[];
  ladder: PerkLadderRowDTO[];
}

/** One "what you did to earn it" row — a signal category (e.g. `vouches`)
 *  or the synthetic `badges` bonus row. `key` is a stable identifier the
 *  frontend resolves to a label/icon itself (no display text crosses the
 *  wire). Owner-only: stripped to `[]` for another member's recognition. */
export interface XpBreakdownItemDTO {
  key: string;
  units: number;
  cap: number;
  perUnit: number;
  xp: number;
}

/** One dated row in a member's XP history, as read from
 *  `RecognitionLedgerEntry`. `[]` until the backend adds real event logging
 *  for a given member (i.e. before their first `recompute()` XP increase) —
 *  the frontend renders its own empty state for that. */
export interface XpLedgerEntryDTO {
  createdAt: string;
  description: string;
  xp: number;
  reason?: string;
}

export interface RecognitionDTO {
  level: LevelDTO;
  levelLadder: LevelLadderRowDTO[];
  badges: BadgesDTO;
  perks: PerksDTO;
  xpBreakdown: XpBreakdownItemDTO[];
  xpLedger: XpLedgerEntryDTO[];
}

/** A single earned badge row, as read from `RecognitionAward`. */
export interface EarnedAwardRow {
  badgeKey: string;
  context: string | null;
  /** Optional so a caller that does not care about visibility (and the older
   *  unit tests) can keep passing two fields. Absent reads as "not hidden". */
  hiddenFromProfile?: boolean;
}

/** A single claimed perk row, as read from `RecognitionPerkClaim`. */
export interface ClaimedPerkRow {
  perkKey: string;
  claimedAt: Date;
}

/** A single ledger row, as read from `RecognitionLedgerEntry`. */
export interface LedgerEntryRow {
  description: string;
  xp: number;
  reason: string | null;
  createdAt: Date;
}

/** Derives level, progress-within-level, `xpToNext` and `nextName` from a
 *  lifetime XP total by walking `LEVEL_LADDER_DEF`'s per-level XP spans. */
export function computeLevel(totalXp: number): LevelDTO {
  let remaining = Math.max(0, Math.trunc(totalXp));
  for (let i = 0; i < LEVEL_LADDER_DEF.length; i++) {
    const def = LEVEL_LADDER_DEF[i];
    if (def === undefined) continue;
    const isMaxLevel = def.xpSpan === null;
    if (isMaxLevel || remaining < def.xpSpan!) {
      const xpMax = isMaxLevel ? 0 : def.xpSpan!;
      const next = LEVEL_LADDER_DEF[i + 1] ?? null;
      return {
        level: def.level,
        name: def.name,
        xp: isMaxLevel ? 0 : remaining,
        xpMax,
        percent: isMaxLevel
          ? 100
          : Math.min(100, Math.round((remaining / xpMax) * 100)),
        xpToNext: isMaxLevel ? 0 : Math.max(0, xpMax - remaining),
        nextName: next ? next.name : null,
      };
    }
    remaining -= def.xpSpan!;
  }
  // Unreachable: the last ladder entry always has `xpSpan: null`, which the
  // loop above catches via `isMaxLevel`.
  // invariant: LEVEL_LADDER_DEF is a non-empty constant, so its last index
  // always resolves to an entry.
  const last = LEVEL_LADDER_DEF[LEVEL_LADDER_DEF.length - 1]!;
  return {
    level: last.level,
    name: last.name,
    xp: 0,
    xpMax: 0,
    percent: 100,
    xpToNext: 0,
    nextName: null,
  };
}

export function buildLevelLadder(currentLevel: number): LevelLadderRowDTO[] {
  return LEVEL_LADDER_DEF.map((def) => ({
    num: def.level,
    name: def.name,
    state:
      def.level < currentLevel
        ? 'done'
        : def.level === currentLevel
          ? 'current'
          : 'locked',
  }));
}

/** `signals` drives locked-badge `progress` and is owner-only (mirrors
 *  `xpBreakdown` below) — pass `null` for a non-owner view so a stranger
 *  can't read e.g. "6 of 10 gatherings attended" off someone else's page. */
export function buildBadges(
  earned: EarnedAwardRow[],
  signals: RecognitionSignals | null = null,
  isOwnerView = true,
): BadgesDTO {
  const earnedByKey = new Map(earned.map((row) => [row.badgeKey, row]));
  const earnedBadges: BadgeDTO[] = [];
  const lockedBadges: BadgeDTO[] = [];
  for (const def of BADGE_CATALOG) {
    const row = earnedByKey.get(def.key);
    // What this badge really pays, from the one function that decides it
    // (`badgeBonusFor`), rather than from rarity alone. A badge a member
    // earns with nobody else involved is awarded and displayed and carries no
    // XP (PRD-05), and `xpReward` is optional precisely so a card can say
    // nothing about XP instead of advertising a reward the member will not
    // receive. Reading `BADGE_BONUS_BY_RARITY` directly here is what made the
    // perk copy fiction the last time (SUS-04); the same mistake, one level
    // down.
    const bonus = badgeBonusFor(def.key);
    const xpReward = bonus > 0 ? bonus : undefined;
    if (row) {
      const isHiddenFromProfile = row.hiddenFromProfile === true;
      // A badge the member has hidden is dropped from ANOTHER member's view
      // entirely — not moved to `locked`, which would tell the viewer the
      // badge exists and is unearned, and would still be a disclosure the
      // member asked us not to make. On the owner's own view it stays, marked,
      // so they can see and undo what they hid.
      if (isHiddenFromProfile && !isOwnerView) continue;
      earnedBadges.push({
        key: def.key,
        cat: def.cat,
        name: def.name,
        context: row.context ?? def.earnedContext,
        rarity: def.rarity,
        tint: def.tint,
        xpReward,
        verifiedBy: def.verifiedBy,
        hiddenFromProfile: isHiddenFromProfile ? true : undefined,
      });
    } else if (BADGE_REQUIREMENTS[def.key]) {
      lockedBadges.push({
        key: def.key,
        cat: def.cat,
        name: def.name,
        context: def.lockedContext,
        rarity: def.rarity,
        tint: def.tint,
        xpReward,
        verifiedBy: def.verifiedBy,
        progress: signals ? badgeProgress(def.key, signals) : undefined,
      });
    }
    // else: catalogue entry with no `BADGE_REQUIREMENTS` wiring (e.g.
    // `founding-member`) — omitted from the locked grid rather than shown
    // with earning instructions that lead nowhere (COM-14).
  }
  return {
    earnedCount: earnedBadges.length,
    // Only counts badges a member can actually still go earn — matches what
    // `locked` now contains, so "N of M badges" never advertises a total
    // that includes unobtainable catalogue entries.
    discoverCount: lockedBadges.length,
    earned: earnedBadges,
    locked: lockedBadges,
    seasonal: buildSeasonalBadges(),
  };
}

/** Time-limited badges are purely informational today (no award path — see
 *  `SEASONAL_BADGE_CATALOG`), so every entry renders the same for every
 *  viewer: locked context, no `progress`. Filtered the same way as the main
 *  locked grid (COM-14): a seasonal entry only surfaces once it has a real
 *  `BADGE_REQUIREMENTS` signal, so the plum "seasonal" band never promises an
 *  earning path ("March with the QueerPulse block") that doesn't exist yet.
 *  Today none of them do, so this returns `[]` until one is wired. */
function buildSeasonalBadges(): BadgeDTO[] {
  return SEASONAL_BADGE_CATALOG.filter(
    (def) => BADGE_REQUIREMENTS[def.key],
  ).map((def) => ({
    key: def.key,
    cat: def.cat,
    name: def.name,
    context: def.lockedContext,
    rarity: def.rarity,
    tint: def.tint,
    xpReward: badgeBonusFor(def.key),
    verifiedBy: def.verifiedBy,
    seasonal: { when: def.window },
  }));
}

/** Maps stored ledger rows to the frontend's `XpLedgerEntryDTO` shape.
 *  Owner-only — see `buildRecognition`. */
export function buildXpLedger(rows: LedgerEntryRow[]): XpLedgerEntryDTO[] {
  return rows.map((row) => ({
    createdAt: row.createdAt.toISOString(),
    description: row.description,
    xp: row.xp,
    reason: row.reason ?? undefined,
  }));
}

function xpAwayLabel(unlockLevel: number, totalXp: number): string {
  const away = Math.max(0, levelStartXp(unlockLevel) - Math.max(0, totalXp));
  return `${away} XP away`;
}

/**
 * The perk card's copy, with the invite-quota numbers filled in from the ONE
 * place that decides them (`INVITE_QUOTA_BONUS_BY_LEVEL`) plus the base quota
 * this deployment actually enforces. A perk with no `{base}`/`{total}` in its
 * text is returned untouched.
 */
export function perkDescription(
  def: PerkCatalogEntry,
  baseInviteQuota: number,
): string {
  if (def.isInviteQuotaPerk !== true) return def.desc;
  const total = baseInviteQuota + inviteQuotaBonusForLevel(def.unlockLevel);
  return def.desc
    .replace('{base}', String(baseInviteQuota))
    .replace('{total}', String(total));
}

/**
 * `baseInviteQuota` is the deployment's configured `app.inviteMonthlyQuota`,
 * passed in by `RecognitionService` so the invite-quota perk copy names the
 * number `InvitesService` will really enforce. It defaults to the same
 * constant `app.config.ts` defaults to, so a caller without a `ConfigService`
 * still cannot print a number the backend would not honour.
 */
export function buildPerks(
  currentLevel: number,
  totalXp: number,
  claimed: ClaimedPerkRow[],
  baseInviteQuota: number = DEFAULT_INVITE_MONTHLY_QUOTA,
): PerksDTO {
  const claimedByKey = new Map(claimed.map((row) => [row.perkKey, row]));
  const available: PerkDTO[] = [];
  const claimedPerks: PerkDTO[] = [];
  const lockedByLevel = new Map<number, PerkDTO[]>();

  for (const def of PERK_CATALOG) {
    const desc = perkDescription(def, baseInviteQuota);
    const claim = claimedByKey.get(def.key);
    if (claim) {
      claimedPerks.push({
        key: def.key,
        cat: def.cat,
        title: def.title,
        desc,
        state: 'claimed',
        footer: { type: 'claimed', date: claim.claimedAt.toISOString() },
      });
    } else if (currentLevel >= def.unlockLevel) {
      available.push({
        key: def.key,
        cat: def.cat,
        title: def.title,
        desc,
        state: 'available',
        footer: def.availableFooter,
      });
    } else {
      const bucket = lockedByLevel.get(def.unlockLevel) ?? [];
      bucket.push({
        key: def.key,
        cat: def.cat,
        title: def.title,
        desc,
        state: 'locked',
        footer: {
          type: 'lock',
          label: `Unlocks at Level ${def.unlockLevel} · ${levelName(def.unlockLevel)}`,
        },
      });
      lockedByLevel.set(def.unlockLevel, bucket);
    }
  }

  const groups: PerkGroupDTO[] = [];
  if (available.length > 0) {
    groups.push({ label: 'Available to claim', perks: available });
  }
  for (const lvl of [...lockedByLevel.keys()].sort((a, b) => a - b)) {
    groups.push({
      label: `Coming at Level ${lvl} · ${levelName(lvl)}`,
      perks: lockedByLevel.get(lvl)!,
    });
  }
  if (claimedPerks.length > 0) {
    groups.push({ label: 'Already claimed', perks: claimedPerks });
  }

  const ladder: PerkLadderRowDTO[] = LEVEL_LADDER_DEF.map((def) => {
    const perksAtLevel = [
      ...(BASE_PERKS_BY_LEVEL[def.level] ?? []),
      ...PERK_CATALOG.filter((p) => p.unlockLevel === def.level).map(
        (p) => p.title,
      ),
    ];
    const state: PerkLadderState =
      def.level < currentLevel
        ? 'achieved'
        : def.level === currentLevel
          ? 'current'
          : 'locked';
    const status =
      state === 'achieved'
        ? 'Done'
        : state === 'current'
          ? 'Current'
          : xpAwayLabel(def.level, totalXp);
    return {
      num: def.level,
      name: def.name,
      state,
      status,
      perks: perksAtLevel,
    };
  });

  return { availableCount: available.length, groups, ladder };
}

/** Itemizes live signals into `XpBreakdownItemDTO` rows, plus a synthetic
 *  `badges` row for badge-bonus XP (no single `perUnit` — bonus varies by
 *  rarity, so it's omitted as 0). `signals` is `null` for a non-owner view,
 *  where the breakdown is stripped entirely (mirrors the perks I9 rule). */
export function buildXpBreakdown(
  signals: RecognitionSignals | null,
  heldBadgeKeys: string[],
): XpBreakdownItemDTO[] {
  if (!signals) return [];
  return [
    ...xpBreakdown(signals),
    {
      key: 'badges',
      units: heldBadgeKeys.length,
      cap: BADGE_CATALOG.length,
      perUnit: 0,
      xp: badgeBonusXp(heldBadgeKeys),
    },
  ];
}

/**
 * `options.baseInviteQuota` is the deployment's configured monthly invite
 * allowance (see `buildPerks`). `options.isOwnerView` decides whether a badge
 * the member has hidden is returned at all; it defaults to `signals !== null`,
 * which is exactly how the owner/non-owner split is already expressed
 * everywhere else in this file (`xpBreakdown`, `xpLedger`, perks).
 */
export function buildRecognition(
  totalXp: number,
  earned: EarnedAwardRow[],
  claimed: ClaimedPerkRow[],
  signals: RecognitionSignals | null = null,
  ledgerRows: LedgerEntryRow[] = [],
  options: { baseInviteQuota?: number; isOwnerView?: boolean } = {},
): RecognitionDTO {
  const level = computeLevel(totalXp);
  const isOwnerView = options.isOwnerView ?? signals !== null;
  return {
    level,
    levelLadder: buildLevelLadder(level.level),
    badges: buildBadges(earned, signals, isOwnerView),
    perks: buildPerks(level.level, totalXp, claimed, options.baseInviteQuota),
    xpBreakdown: buildXpBreakdown(
      signals,
      earned.map((a) => a.badgeKey),
    ),
    xpLedger: signals ? buildXpLedger(ledgerRows) : [],
  };
}
