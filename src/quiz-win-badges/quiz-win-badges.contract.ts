import type { MemberRef } from '../common/member-ref';
import type {
  BadgeRarity,
  BadgeTint,
} from '../recognition/recognition.catalog';

/** Key prefix of every quiz badge award: `quiz:<definition id>`. No code
 *  catalogue key contains a colon, so the prefix never collides. */
export const QUIZ_BADGE_KEY_PREFIX = 'quiz:';

/** `BadgeDTO.cat` of every admin quiz badge. */
export const QUIZ_BADGE_CATEGORY = 'Quiz nights';

/** Longest badge name, in code points. */
export const QUIZ_BADGE_NAME_MAX_LENGTH = 40;

/** Longest badge description, in code points. */
export const QUIZ_BADGE_DESCRIPTION_MAX_LENGTH = 140;

/** Games of one event that can give badges. */
export const QUIZ_EVENT_GAME_SLOTS_MAX = 5;

/** Badges one game can give. */
export const QUIZ_BADGES_PER_GAME_MAX = 3;

/** Longest revoke reason, in code points. */
export const QUIZ_REVOKE_REASON_MAX_LENGTH = 300;

/** A longer event search `q` is cut to this length and served. */
export const QUIZ_EVENT_SEARCH_MAX_LENGTH = 100;

/** Wins listed per badge in a recognition read. */
export const QUIZ_BADGE_WINS_PER_BADGE_MAX = 100;

/** The badge colours an admin can pick (the `BadgeTint` set). */
export const QUIZ_BADGE_TINTS = ['jade', 'accent', 'plum'] as const;

/** The badge rarities an admin can pick (the `BadgeRarity` set). */
export const QUIZ_BADGE_RARITIES = ['common', 'rare', 'legendary'] as const;

/** True for an award key that belongs to a quiz badge. */
export function isQuizBadgeKey(key: string): boolean {
  return key.startsWith(QUIZ_BADGE_KEY_PREFIX);
}

/** The award key of a quiz badge definition. */
export function quizBadgeKeyOf(definitionId: string): string {
  return QUIZ_BADGE_KEY_PREFIX + definitionId;
}

/** A text in both languages; a null Portuguese text reads as the English one. */
export interface QuizBadgeText {
  en: string;
  pt: string | null;
}

/** The compact badge every member-facing and admin surface draws. */
export interface QuizWinBadgeChip {
  definitionId: string;
  /** `quiz:<definitionId>` */
  badgeKey: string;
  name: QuizBadgeText;
  iconKey: string;
  tint: BadgeTint;
  rarity: BadgeRarity;
  isArchived: boolean;
}

/** The columns a definition row must carry to become a chip. */
export interface QuizBadgeChipSource {
  id: string;
  badgeKey: string;
  nameEn: string;
  namePt: string | null;
  iconKey: string;
  tint: BadgeTint;
  rarity: BadgeRarity;
  archivedAt: Date | null;
}

/** Maps a definition row to its chip. Every service and read goes through it. */
export function quizWinBadgeChipOf(
  source: QuizBadgeChipSource,
): QuizWinBadgeChip {
  return {
    definitionId: source.id,
    badgeKey: source.badgeKey,
    name: { en: source.nameEn, pt: source.namePt },
    iconKey: source.iconKey,
    tint: source.tint,
    rarity: source.rarity,
    isArchived: source.archivedAt !== null,
  };
}

/** Admin library row and create/edit echo. Dates are ISO strings. */
export interface QuizBadgeDefinitionDTO {
  id: string;
  badgeKey: string;
  name: QuizBadgeText;
  description: QuizBadgeText;
  iconKey: string;
  tint: BadgeTint;
  rarity: BadgeRarity;
  isArchived: boolean;
  archivedAt: string | null;
  /** Distinct members with at least one live win. */
  holderCount: number;
  /** Live win rows. */
  winCount: number;
  /** Distinct events whose slots use it. */
  eventCount: number;
  /** True when winCount is 0. */
  canDelete: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Live badges first by English name ascending, then archived ones the same
 *  way; capped at DEFAULT_LIST_LIMIT. */
export interface QuizBadgeLibraryResponse {
  items: QuizBadgeDefinitionDTO[];
}

/** One row of the admin event search. */
export interface QuizEventSearchRowDTO {
  eventId: string;
  slug: string;
  title: string;
  startAt: string;
  status: 'draft' | 'published' | 'cancelled';
  /** `formatDetails.isAdultsOnly` */
  isAdultsOnly: boolean;
  /** Distinct game numbers with at least one slot. */
  configuredGameCount: number;
  /** Sessions with `event_game_number` set. */
  finishedGameCount: number;
}

/** One game of the setup grid; all five are always present. */
export interface QuizEventGameSlotDTO {
  /** 1 to 5 */
  gameNumber: number;
  /** Slot order: created_at ascending. */
  badges: QuizWinBadgeChip[];
  /** A session of this event carries this number. */
  isFinished: boolean;
}

/** One live win of a member in a game. */
export interface QuizBadgeWinRefDTO {
  winId: string;
  badge: QuizWinBadgeChip;
  wonAt: string;
}

/** A recorded winner of a finished game, staff view. */
export interface QuizGameWinnerDTO {
  /** `quiz_game_winners.id` */
  winnerId: string;
  screenName: string;
  teamName: string | null;
  /** Staff view; null when the account is gone. */
  member: MemberRef | null;
  /** Live wins of this member in this game; empty once revoked. */
  wins: QuizBadgeWinRefDTO[];
  isRevoked: boolean;
  revokedAt: string | null;
  revokeReason: string | null;
  /** Null when unrevoked or the account is gone. */
  revokedBy: MemberRef | null;
}

/** A finished, numbered game of the event. */
export interface QuizFinishedGameDTO {
  gameNumber: number;
  sessionId: string;
  finishedAt: string;
  playMode: 'solo' | 'teams';
  /** Live and revoked; empty means "No winner recorded"; team ascending then
   *  screen name ascending. */
  winners: QuizGameWinnerDTO[];
}

/** The per-event badge setup read (route 7 detail and route 8 echo). */
export interface QuizEventBadgeSetupDTO {
  event: {
    id: string;
    slug: string;
    title: string;
    startAt: string;
    status: 'draft' | 'published' | 'cancelled';
    isAdultsOnly: boolean;
    isPublic: boolean;
  };
  /** max(event_game_number) + 1, or 1 when none. */
  nextGameNumber: number;
  limits: { gameSlotsMax: number; badgesPerGameMax: number };
  games: QuizEventGameSlotDTO[];
  /** Game number ascending, every numbered game, also beyond 5. */
  finishedGames: QuizFinishedGameDTO[];
}

/** Response of the setup save. */
export interface QuizEventBadgeSetupSaveResponse {
  setup: QuizEventBadgeSetupDTO;
  /** Win rows written after the fact by this save. */
  awardedWinCount: number;
}

/** Response of the whole-game revoke. */
export interface QuizGameWinRevokeResponse {
  winnerId: string;
  /** Every badge key whose win row this revoke deleted. */
  revokedBadgeKeys: string[];
  /** The subset whose recognition_awards row went too. */
  removedAwardKeys: string[];
}

/** "Win to earn": the next game's badges. */
export interface QuizshowWinBadgesPreview {
  gameNumber: number;
  badges: QuizWinBadgeChip[];
}

/** Results card addition: one winning player or team. */
export interface QuizshowResultsWinnerBadges {
  kind: 'player' | 'team';
  /** Screen name or team name. */
  name: string;
  badges: QuizWinBadgeChip[];
}

/** Results card addition. */
export interface QuizshowResultsWinBadges {
  gameNumber: number;
  /** Entries with at least one live badge, name ascending. */
  winners: QuizshowResultsWinnerBadges[];
  /** The viewer's own live wins in this session. */
  myBadges: QuizWinBadgeChip[];
}

/** Recognition read addition: one win of a member. */
export interface QuizBadgeWinDTO {
  wonAt: string;
  gameNumber: number;
  /** Null means masked; the client shows "QueerPulse quiz night". */
  eventName: string | null;
  /** Null when masked or the event is gone. */
  eventSlug: string | null;
  /** Owner read: event_was_adults_only; other viewers: always false. */
  isAdultsOnlyEvent: boolean;
}

/** Recognition read addition: one quiz badge with its wins. */
export interface QuizBadgeDetailsDTO {
  definitionId: string;
  name: QuizBadgeText;
  description: QuizBadgeText;
  iconKey: string;
  /** Every live win, masked ones included. */
  winCount: number;
  /** won_at descending, at most QUIZ_BADGE_WINS_PER_BADGE_MAX. */
  wins: QuizBadgeWinDTO[];
}
