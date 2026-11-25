import type { EntityManager } from 'typeorm';
import type {
  BadgeRarity,
  BadgeTint,
} from '../recognition/recognition.catalog';
import {
  quizWinBadgeChipOf,
  type QuizshowResultsWinBadges,
  type QuizshowResultsWinnerBadges,
  type QuizWinBadgeChip,
} from './quiz-win-badges.contract';

/** The event and game number of a session. $1 = session id. */
export const RESULTS_SESSION_GAME_SQL = `
  SELECT "event_id", "event_game_number"
  FROM "quizshow_sessions"
  WHERE "id" = $1
`;

/**
 * The live wins of a session joined to the live winner row and the badge
 * definition. It selects names and chip columns and a mine flag; no user id
 * leaves the query. $1 = session id, $2 = viewer user id.
 */
export const RESULTS_WIN_ROWS_SQL = `
  SELECT
    ("win"."user_id" = $2) AS "is_mine",
    "winner"."id" AS "winner_id",
    "winner"."screen_name" AS "screen_name",
    "winner"."team_name" AS "team_name",
    "definition"."id" AS "definition_id",
    "definition"."badge_key" AS "badge_key",
    "definition"."name_en" AS "name_en",
    "definition"."name_pt" AS "name_pt",
    "definition"."icon_key" AS "icon_key",
    "definition"."tint" AS "tint",
    "definition"."rarity" AS "rarity",
    "definition"."archived_at" AS "archived_at"
  FROM "quiz_badge_wins" "win"
  INNER JOIN "quiz_game_winners" "winner"
    ON "winner"."session_id" = "win"."session_id"
    AND "winner"."user_id" = "win"."user_id"
    AND "winner"."revoked_at" IS NULL
  INNER JOIN "quiz_badge_definitions" "definition"
    ON "definition"."id" = "win"."badge_definition_id"
  WHERE "win"."session_id" = $1
  ORDER BY "definition"."name_en" ASC, "definition"."id" ASC
`;

interface ResultsSessionGameRow {
  event_id: string | null;
  event_game_number: number | string | null;
}

interface ResultsWinRow {
  is_mine: boolean;
  winner_id: string;
  screen_name: string;
  team_name: string | null;
  definition_id: string;
  badge_key: string;
  name_en: string;
  name_pt: string | null;
  icon_key: string;
  tint: BadgeTint;
  rarity: BadgeRarity;
  archived_at: Date | null;
}

interface ResultsWinnerGroup {
  kind: 'player' | 'team';
  name: string;
  chipsByDefinitionId: Map<string, QuizWinBadgeChip>;
}

function chipOfWinRow(row: ResultsWinRow): QuizWinBadgeChip {
  return quizWinBadgeChipOf({
    id: row.definition_id,
    badgeKey: row.badge_key,
    nameEn: row.name_en,
    namePt: row.name_pt,
    iconKey: row.icon_key,
    tint: row.tint,
    rarity: row.rarity,
    archivedAt: row.archived_at,
  });
}

/**
 * Reads the win badges of a finished event game for the results card: one
 * entry per winning team (teams play) or per winning player, the viewer's own
 * badges, and the game number. Null for a game session, an unnumbered session
 * or a session with no live win.
 */
export async function readResultsWinBadges(
  manager: Pick<EntityManager, 'query'>,
  input: {
    sessionId: string;
    viewerUserId: string;
    playMode: 'solo' | 'teams';
  },
): Promise<QuizshowResultsWinBadges | null> {
  const sessionRows: ResultsSessionGameRow[] = await manager.query(
    RESULTS_SESSION_GAME_SQL,
    [input.sessionId],
  );
  const sessionRow = sessionRows[0];
  if (
    sessionRow === undefined ||
    sessionRow.event_id === null ||
    sessionRow.event_game_number === null
  ) {
    return null;
  }
  const winRows: ResultsWinRow[] = await manager.query(RESULTS_WIN_ROWS_SQL, [
    input.sessionId,
    input.viewerUserId,
  ]);
  if (winRows.length === 0) {
    return null;
  }

  const groupsByKey = new Map<string, ResultsWinnerGroup>();
  const myChipsByDefinitionId = new Map<string, QuizWinBadgeChip>();
  for (const row of winRows) {
    const isTeamEntry = input.playMode === 'teams' && row.team_name !== null;
    const groupKey = isTeamEntry
      ? `team:${row.team_name}`
      : `winner:${row.winner_id}`;
    let group = groupsByKey.get(groupKey);
    if (group === undefined) {
      group = {
        kind: isTeamEntry ? 'team' : 'player',
        name: isTeamEntry ? (row.team_name as string) : row.screen_name,
        chipsByDefinitionId: new Map(),
      };
      groupsByKey.set(groupKey, group);
    }
    const chip = chipOfWinRow(row);
    if (!group.chipsByDefinitionId.has(chip.definitionId)) {
      group.chipsByDefinitionId.set(chip.definitionId, chip);
    }
    if (row.is_mine && !myChipsByDefinitionId.has(chip.definitionId)) {
      myChipsByDefinitionId.set(chip.definitionId, chip);
    }
  }

  const winners: QuizshowResultsWinnerBadges[] = [...groupsByKey.values()]
    .map((group) => ({
      kind: group.kind,
      name: group.name,
      badges: [...group.chipsByDefinitionId.values()],
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    gameNumber: Number(sessionRow.event_game_number),
    winners,
    myBadges: [...myChipsByDefinitionId.values()],
  };
}
