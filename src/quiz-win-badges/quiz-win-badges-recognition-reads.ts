import type { EntityManager } from 'typeorm';
import type {
  BadgeRarity,
  BadgeTint,
} from '../recognition/recognition.catalog';
import {
  QUIZ_BADGE_WINS_PER_BADGE_MAX,
  isQuizBadgeKey,
  type QuizBadgeDetailsDTO,
  type QuizBadgeWinDTO,
} from './quiz-win-badges.contract';

/**
 * Pure raw SQL reads for the quiz badges of a member's recognition page. They
 * use table names only and take the manager as an argument, so the recognition
 * module imports plain functions and no new provider.
 */

/** The only manager method these reads call. */
export type QuizReadTarget = Pick<EntityManager, 'query'>;

/** A quiz badge a member holds, ready for the recognition response builder. */
export interface QuizBadgeForMember {
  /** `quiz:<definition id>` */
  badgeKey: string;
  rarity: BadgeRarity;
  tint: BadgeTint;
  hiddenFromProfile: boolean;
  awardedAt: Date;
  details: QuizBadgeDetailsDTO;
}

/**
 * $1 member id, $2 whether the owner is reading. Award rows of quiz badges
 * joined to their definitions. A hidden award row drops out for every viewer
 * but the owner.
 */
export const MEMBER_QUIZ_AWARDS_SQL = `
  SELECT
    "award"."badge_key" AS "badge_key",
    "award"."hidden_from_profile" AS "hidden_from_profile",
    "award"."awarded_at" AS "awarded_at",
    "definition"."id" AS "definition_id",
    "definition"."name_en" AS "name_en",
    "definition"."name_pt" AS "name_pt",
    "definition"."description_en" AS "description_en",
    "definition"."description_pt" AS "description_pt",
    "definition"."icon_key" AS "icon_key",
    "definition"."tint" AS "tint",
    "definition"."rarity" AS "rarity"
  FROM "recognition_awards" "award"
  INNER JOIN "quiz_badge_definitions" "definition"
    ON "definition"."badge_key" = "award"."badge_key"
  WHERE "award"."user_id" = $1
    AND "award"."badge_key" LIKE 'quiz:%'
    AND ($2::boolean OR "award"."hidden_from_profile" = false)
  ORDER BY "award"."awarded_at" ASC, "definition"."id" ASC
`;

/**
 * $1 member id, $2 definition ids (uuid[]), $3 wins listed per badge. Every
 * live win of the member for those definitions, newest first within each
 * definition, with the count of all of them and, when the event still exists,
 * its live slug, whether it is public and published now and whether it is
 * 18+ now (both null for a deleted event). Only the first $3 per definition
 * come back.
 */
export const MEMBER_QUIZ_WINS_SQL = `
  SELECT * FROM (
    SELECT
      "win"."badge_definition_id" AS "badge_definition_id",
      "win"."won_at" AS "won_at",
      "win"."game_number" AS "game_number",
      "win"."event_name_snapshot" AS "event_name_snapshot",
      "win"."event_was_public" AS "event_was_public",
      "win"."event_was_adults_only" AS "event_was_adults_only",
      "event"."slug" AS "event_slug",
      CASE WHEN "event"."id" IS NULL THEN NULL ELSE ("event"."visibility" = 'public' AND "event"."status" = 'published') END AS "event_is_public_now",
      CASE WHEN "event"."id" IS NULL THEN NULL ELSE COALESCE(("event"."format_details" ->> 'isAdultsOnly') = 'true', false) END AS "event_is_adults_only_now",
      ROW_NUMBER() OVER (PARTITION BY "win"."badge_definition_id" ORDER BY "win"."won_at" DESC, "win"."id" DESC) AS "position",
      COUNT(*) OVER (PARTITION BY "win"."badge_definition_id")::int AS "win_count"
    FROM "quiz_badge_wins" "win"
    LEFT JOIN "events" "event" ON "event"."id" = "win"."event_id"
    WHERE "win"."user_id" = $1
      AND "win"."badge_definition_id" = ANY($2::uuid[])
  ) "ranked"
  WHERE "ranked"."position" <= $3
  ORDER BY "ranked"."badge_definition_id" ASC, "ranked"."position" ASC
`;

/** One row of `MEMBER_QUIZ_AWARDS_SQL`. */
interface MemberQuizAwardRow {
  badge_key: string;
  hidden_from_profile: boolean;
  awarded_at: Date;
  definition_id: string;
  name_en: string;
  name_pt: string | null;
  description_en: string;
  description_pt: string | null;
  icon_key: string;
  tint: BadgeTint;
  rarity: BadgeRarity;
}

/** One row of `MEMBER_QUIZ_WINS_SQL`. */
interface MemberQuizWinRow {
  badge_definition_id: string;
  won_at: Date | string;
  game_number: number;
  event_name_snapshot: string;
  event_was_public: boolean;
  event_was_adults_only: boolean;
  event_slug: string | null;
  event_is_public_now: boolean | null;
  event_is_adults_only_now: boolean | null;
  win_count: number;
}

/** The start of the UTC day of a time, as an ISO string. */
function startOfUtcDayIso(value: Date | string): string {
  const time = new Date(value);
  return new Date(
    Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate()),
  ).toISOString();
}

/**
 * Maps one win row for the viewer. The owner gets the event name kept with the
 * win, the live slug, the 18+ flag and the exact win time. Another viewer gets
 * the name and slug only when the event was public, published and open to
 * every age at award time and, while it still exists, still is; the 18+ flag
 * is always false for them, and a masked win carries only its day (the start
 * of its UTC day).
 */
function mapWinRow(
  row: MemberQuizWinRow,
  isOwnerView: boolean,
): QuizBadgeWinDTO {
  const wonAt = new Date(row.won_at).toISOString();
  if (isOwnerView) {
    return {
      wonAt,
      gameNumber: row.game_number,
      eventName: row.event_name_snapshot,
      eventSlug: row.event_slug,
      isAdultsOnlyEvent: row.event_was_adults_only,
    };
  }
  const isLiveEventShown =
    row.event_is_public_now !== false && row.event_is_adults_only_now !== true;
  const isNameVisible =
    row.event_was_public && !row.event_was_adults_only && isLiveEventShown;
  return {
    wonAt: isNameVisible ? wonAt : startOfUtcDayIso(row.won_at),
    gameNumber: row.game_number,
    eventName: isNameVisible ? row.event_name_snapshot : null,
    eventSlug: isNameVisible ? row.event_slug : null,
    isAdultsOnlyEvent: false,
  };
}

/**
 * The quiz badges a member holds, oldest award first. Two queries at most: the
 * award rows, then (only when there are any) their wins. An award row without
 * a live win is skipped. Another viewer gets `awardedAt` at the start of its
 * UTC day for every badge, so the award time never gives away the exact time
 * of a masked win; the owner gets the exact time.
 */
export async function readQuizBadgesForMember(
  manager: QuizReadTarget,
  userId: string,
  options: { isOwnerView: boolean },
): Promise<QuizBadgeForMember[]> {
  const awardRows = await manager.query<MemberQuizAwardRow[]>(
    MEMBER_QUIZ_AWARDS_SQL,
    [userId, options.isOwnerView],
  );
  if (awardRows.length === 0) return [];

  const winRows = await manager.query<MemberQuizWinRow[]>(
    MEMBER_QUIZ_WINS_SQL,
    [
      userId,
      awardRows.map((awardRow) => awardRow.definition_id),
      QUIZ_BADGE_WINS_PER_BADGE_MAX,
    ],
  );

  const winRowsByDefinitionId = new Map<string, MemberQuizWinRow[]>();
  for (const winRow of winRows) {
    const rowsOfDefinition =
      winRowsByDefinitionId.get(winRow.badge_definition_id) ?? [];
    rowsOfDefinition.push(winRow);
    winRowsByDefinitionId.set(winRow.badge_definition_id, rowsOfDefinition);
  }

  const badges: QuizBadgeForMember[] = [];
  for (const awardRow of awardRows) {
    const rowsOfDefinition = winRowsByDefinitionId.get(awardRow.definition_id);
    const newestWinRow = rowsOfDefinition?.[0];
    if (!rowsOfDefinition || !newestWinRow) continue;
    badges.push({
      badgeKey: awardRow.badge_key,
      rarity: awardRow.rarity,
      tint: awardRow.tint,
      hiddenFromProfile: awardRow.hidden_from_profile,
      awardedAt: options.isOwnerView
        ? awardRow.awarded_at
        : new Date(startOfUtcDayIso(awardRow.awarded_at)),
      details: {
        definitionId: awardRow.definition_id,
        name: { en: awardRow.name_en, pt: awardRow.name_pt },
        description: {
          en: awardRow.description_en,
          pt: awardRow.description_pt,
        },
        iconKey: awardRow.icon_key,
        winCount: newestWinRow.win_count,
        wins: rowsOfDefinition.map((winRow) =>
          mapWinRow(winRow, options.isOwnerView),
        ),
      },
    });
  }
  return badges;
}

/**
 * True when `key` is a quiz badge key whose definition exists, archived ones
 * included. A key that is not shaped like a quiz key costs no query.
 */
export async function isKnownQuizBadgeKey(
  manager: QuizReadTarget,
  key: string,
): Promise<boolean> {
  if (!isQuizBadgeKey(key)) return false;
  const rows = await manager.query<Array<{ exists: boolean }>>(
    `SELECT EXISTS (SELECT 1 FROM "quiz_badge_definitions" WHERE "badge_key" = $1) AS "exists"`,
    [key],
  );
  return rows[0]?.exists === true;
}
