import type { EntityManager } from 'typeorm';
import type {
  BadgeRarity,
  BadgeTint,
} from '../recognition/recognition.catalog';
import {
  QUIZ_EVENT_GAME_SLOTS_MAX,
  quizWinBadgeChipOf,
  type QuizshowWinBadgesPreview,
  type QuizWinBadgeChip,
} from './quiz-win-badges.contract';

/**
 * "Win to earn": the badges the next game of an event gives. The next game
 * number is the highest `event_game_number` of the event plus one, or 1 when
 * no session of the event is numbered. The slots are LEFT JOINed, so a game
 * with no badges still returns one row (null chip columns). Archived badges
 * on a slot show. $1 = event id.
 */
export const NEXT_GAME_WIN_BADGES_SQL = `
  WITH "next_game" AS (
    SELECT COALESCE(MAX("event_game_number"), 0) + 1 AS "game_number"
    FROM "quizshow_sessions"
    WHERE "event_id" = $1
  )
  SELECT
    "next_game"."game_number" AS "game_number",
    "definition"."id" AS "definition_id",
    "definition"."badge_key" AS "badge_key",
    "definition"."name_en" AS "name_en",
    "definition"."name_pt" AS "name_pt",
    "definition"."icon_key" AS "icon_key",
    "definition"."tint" AS "tint",
    "definition"."rarity" AS "rarity",
    "definition"."archived_at" AS "archived_at"
  FROM "next_game"
  LEFT JOIN "quiz_event_badge_slots" "slot"
    ON "slot"."event_id" = $1
    AND "slot"."game_number" = "next_game"."game_number"
  LEFT JOIN "quiz_badge_definitions" "definition"
    ON "definition"."id" = "slot"."badge_definition_id"
  ORDER BY "slot"."created_at" ASC, "slot"."id" ASC
`;

interface NextGameWinBadgesRow {
  game_number: number | string;
  definition_id: string | null;
  badge_key: string | null;
  name_en: string | null;
  name_pt: string | null;
  icon_key: string | null;
  tint: BadgeTint | null;
  rarity: BadgeRarity | null;
  archived_at: Date | null;
}

/**
 * Reads the badges of the event's next game in slot order. Null when the next
 * game number is above the fifth or the game gives no badge.
 */
export async function readNextGameWinBadges(
  manager: Pick<EntityManager, 'query'>,
  eventId: string,
): Promise<QuizshowWinBadgesPreview | null> {
  const rows: NextGameWinBadgesRow[] = await manager.query(
    NEXT_GAME_WIN_BADGES_SQL,
    [eventId],
  );
  const firstRow = rows[0];
  if (firstRow === undefined) {
    return null;
  }
  const gameNumber = Number(firstRow.game_number);
  if (gameNumber > QUIZ_EVENT_GAME_SLOTS_MAX) {
    return null;
  }
  const badges: QuizWinBadgeChip[] = [];
  for (const row of rows) {
    if (
      row.definition_id === null ||
      row.badge_key === null ||
      row.name_en === null ||
      row.icon_key === null ||
      row.tint === null ||
      row.rarity === null
    ) {
      continue;
    }
    badges.push(
      quizWinBadgeChipOf({
        id: row.definition_id,
        badgeKey: row.badge_key,
        nameEn: row.name_en,
        namePt: row.name_pt,
        iconKey: row.icon_key,
        tint: row.tint,
        rarity: row.rarity,
        archivedAt: row.archived_at,
      }),
    );
  }
  if (badges.length === 0) {
    return null;
  }
  return { gameNumber, badges };
}
