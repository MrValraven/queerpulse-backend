import {
  BADGE_CATALOG,
  BASE_PERKS_BY_LEVEL,
  BadgeRarity,
  BadgeTint,
  BadgeVerification,
  LEVEL_LADDER_DEF,
  PERK_CATALOG,
  SEASONAL_BADGE_CATALOG,
  levelName,
  levelStartXp,
} from './recognition.catalog';
import {
  BADGE_BONUS_BY_RARITY,
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
): BadgesDTO {
  const earnedByKey = new Map(earned.map((row) => [row.badgeKey, row]));
  const earnedBadges: BadgeDTO[] = [];
  const lockedBadges: BadgeDTO[] = [];
  for (const def of BADGE_CATALOG) {
    const row = earnedByKey.get(def.key);
    const xpReward = BADGE_BONUS_BY_RARITY[def.rarity];
    if (row) {
      earnedBadges.push({
        key: def.key,
        cat: def.cat,
        name: def.name,
        context: row.context ?? def.earnedContext,
        rarity: def.rarity,
        tint: def.tint,
        xpReward,
        verifiedBy: def.verifiedBy,
      });
    } else {
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
  }
  return {
    earnedCount: earnedBadges.length,
    discoverCount: BADGE_CATALOG.length - earnedBadges.length,
    earned: earnedBadges,
    locked: lockedBadges,
    seasonal: buildSeasonalBadges(),
  };
}

/** Time-limited badges are purely informational today (no award path — see
 *  `SEASONAL_BADGE_CATALOG`), so every entry renders the same for every
 *  viewer: locked context, no `progress`. */
function buildSeasonalBadges(): BadgeDTO[] {
  return SEASONAL_BADGE_CATALOG.map((def) => ({
    key: def.key,
    cat: def.cat,
    name: def.name,
    context: def.lockedContext,
    rarity: def.rarity,
    tint: def.tint,
    xpReward: BADGE_BONUS_BY_RARITY[def.rarity],
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

export function buildPerks(
  currentLevel: number,
  totalXp: number,
  claimed: ClaimedPerkRow[],
): PerksDTO {
  const claimedByKey = new Map(claimed.map((row) => [row.perkKey, row]));
  const available: PerkDTO[] = [];
  const claimedPerks: PerkDTO[] = [];
  const lockedByLevel = new Map<number, PerkDTO[]>();

  for (const def of PERK_CATALOG) {
    const claim = claimedByKey.get(def.key);
    if (claim) {
      claimedPerks.push({
        cat: def.cat,
        title: def.title,
        desc: def.desc,
        state: 'claimed',
        footer: { type: 'claimed', date: claim.claimedAt.toISOString() },
      });
    } else if (currentLevel >= def.unlockLevel) {
      available.push({
        cat: def.cat,
        title: def.title,
        desc: def.desc,
        state: 'available',
        footer: def.availableFooter,
      });
    } else {
      const bucket = lockedByLevel.get(def.unlockLevel) ?? [];
      bucket.push({
        cat: def.cat,
        title: def.title,
        desc: def.desc,
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

export function buildRecognition(
  totalXp: number,
  earned: EarnedAwardRow[],
  claimed: ClaimedPerkRow[],
  signals: RecognitionSignals | null = null,
  ledgerRows: LedgerEntryRow[] = [],
): RecognitionDTO {
  const level = computeLevel(totalXp);
  return {
    level,
    levelLadder: buildLevelLadder(level.level),
    badges: buildBadges(earned, signals),
    perks: buildPerks(level.level, totalXp, claimed),
    xpBreakdown: buildXpBreakdown(
      signals,
      earned.map((a) => a.badgeKey),
    ),
    xpLedger: signals ? buildXpLedger(ledgerRows) : [],
  };
}
