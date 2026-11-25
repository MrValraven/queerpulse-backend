import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { MemberLookup } from '../common/member-ref';
import {
  MAX_PAGE,
  PAGE_SIZE,
  Paginated,
  normalizePage,
} from '../common/pagination';
import { codePointLength } from '../community-badges/community-badges.catalog';
import { toStoredPlainTextOrNull } from '../communities/community-plain-text';
import { ModAuditService } from '../moderation/mod-audit.service';
import { isAdultsOnlySession } from '../quizshow/quizshow-play-rules';
import type {
  QuizshowContentLabel,
  QuizshowPlayMode,
} from '../quizshow/quizshow.contract';
import type {
  BadgeRarity,
  BadgeTint,
} from '../recognition/recognition.catalog';
import { Profile } from '../users/entities/profile.entity';
import {
  QuizEventBadgeSetupInputDto,
  QuizGameWinRevokeInputDto,
} from './dto/quiz-win-badges.dto';
import {
  ELIGIBLE_WINNER_USER_IDS_SQL,
  QuizBadgeAwardingService,
  QuizBadgeNewWin,
  returnedRowsOf,
} from './quiz-badge-awarding.service';
import {
  QUIZ_BADGES_PER_GAME_MAX,
  QUIZ_EVENT_GAME_SLOTS_MAX,
  QUIZ_EVENT_SEARCH_MAX_LENGTH,
  QUIZ_REVOKE_REASON_MAX_LENGTH,
  QuizEventBadgeSetupDTO,
  QuizEventBadgeSetupSaveResponse,
  QuizEventSearchRowDTO,
  QuizFinishedGameDTO,
  QuizGameWinRevokeResponse,
  QuizGameWinnerDTO,
  QuizWinBadgeChip,
  quizBadgeKeyOf,
  quizWinBadgeChipOf,
} from './quiz-win-badges.contract';
import {
  QUIZ_BADGE_AUDIT_ACTIONS,
  QUIZ_EVENT_BADGES_LOCK_SQL,
  quizBadgeAuditNote,
  quizWinBadgeError,
} from './quiz-win-badges.constants';

/**
 * Route 7: events with a Pulse Live quiz, newest start first. `$1` the escaped
 * title term (an empty term matches every event), `$2` the row offset.
 * `total` counts every matching event on each row.
 */
export const SEARCH_QUIZ_EVENTS_SQL = `SELECT "event"."id" AS "id", "event"."slug" AS "slug", "event"."title" AS "title", "event"."start_at" AS "start_at", "event"."status" AS "status", COALESCE(("event"."format_details" ->> 'isAdultsOnly') = 'true', false) AS "is_adults_only", (SELECT COUNT(DISTINCT "slot"."game_number") FROM "quiz_event_badge_slots" "slot" WHERE "slot"."event_id" = "event"."id")::int AS "configured_game_count", (SELECT COUNT(*) FROM "quizshow_sessions" "session" WHERE "session"."event_id" = "event"."id" AND "session"."event_game_number" IS NOT NULL)::int AS "finished_game_count", (COUNT(*) OVER ())::int AS "total" FROM "events" "event" WHERE EXISTS (SELECT 1 FROM "quizshow_quizzes" "quiz" WHERE "quiz"."event_id" = "event"."id") AND ($1::text = '' OR "event"."title" ILIKE '%' || $1::text || '%') ORDER BY "event"."start_at" DESC, "event"."id" DESC LIMIT ${PAGE_SIZE} OFFSET $2`;

/** The event a badge setup or revoke works on, with whether it has a quiz:
 *  `$1` event id. */
export const LOAD_QUIZ_BADGE_EVENT_SQL = `SELECT "event"."id" AS "id", "event"."slug" AS "slug", "event"."title" AS "title", "event"."start_at" AS "start_at", "event"."status" AS "status", "event"."visibility" AS "visibility", COALESCE(("event"."format_details" ->> 'isAdultsOnly') = 'true', false) AS "is_adults_only", EXISTS (SELECT 1 FROM "quizshow_quizzes" "quiz" WHERE "quiz"."event_id" = "event"."id") AS "has_quiz" FROM "events" "event" WHERE "event"."id" = $1`;

/** The definitions a setup names: `$1` the definition ids. */
export const READ_SETUP_DEFINITIONS_SQL = `SELECT "definition"."id" AS "id", "definition"."badge_key" AS "badge_key", "definition"."name_en" AS "name_en", "definition"."name_pt" AS "name_pt", "definition"."archived_at" AS "archived_at" FROM "quiz_badge_definitions" "definition" WHERE "definition"."id" = ANY($1::uuid[])`;

/** The definitions a setup names, re-read under the event lock with a share
 *  lock on each row, so an archive or a delete of one of them waits for the
 *  save to commit: `$1` the definition ids. */
export const READ_SETUP_DEFINITIONS_FOR_SHARE_SQL = `${READ_SETUP_DEFINITIONS_SQL} FOR SHARE`;

/** Every slot of one event with its badge chip columns, game ascending and
 *  then attach order: `$1` event id. */
export const READ_EVENT_SLOTS_SQL = `SELECT "slot"."id" AS "slot_id", "slot"."game_number" AS "game_number", "definition"."id" AS "id", "definition"."badge_key" AS "badge_key", "definition"."name_en" AS "name_en", "definition"."name_pt" AS "name_pt", "definition"."icon_key" AS "icon_key", "definition"."tint" AS "tint", "definition"."rarity" AS "rarity", "definition"."archived_at" AS "archived_at" FROM "quiz_event_badge_slots" "slot" JOIN "quiz_badge_definitions" "definition" ON "definition"."id" = "slot"."badge_definition_id" WHERE "slot"."event_id" = $1 ORDER BY "slot"."game_number" ASC, "slot"."created_at" ASC, "slot"."id" ASC`;

/** Deletes one slot row: `$1` slot id. */
export const DELETE_EVENT_SLOT_SQL = `DELETE FROM "quiz_event_badge_slots" WHERE "id" = $1`;

/**
 * Attaches one badge to one game: `$1` event id, `$2` game number, `$3`
 * definition id, `$4` the attaching admin. `clock_timestamp()` keeps the
 * attach order of one save, since every row of one transaction would share
 * `now()`.
 */
export const INSERT_EVENT_SLOT_SQL = `INSERT INTO "quiz_event_badge_slots" ("event_id", "game_number", "badge_definition_id", "created_by_id", "created_at") VALUES ($1, $2, $3, $4, clock_timestamp())`;

/** The numbered session of one game with its snapshot rounds: `$1` event id,
 *  `$2` game number. */
export const READ_NUMBERED_GAME_SESSION_SQL = `SELECT "session"."id" AS "id", "session"."quiz_snapshot" -> 'rounds' AS "rounds" FROM "quizshow_sessions" "session" WHERE "session"."event_id" = $1 AND "session"."event_game_number" = $2`;

/** The live winner rows of one game: `$1` event id, `$2` game number. A
 *  revoked winner is left out, so a badge attached later skips them. */
export const READ_LIVE_GAME_WINNERS_SQL = `SELECT "id", "session_id", "user_id", "finished_at" FROM "quiz_game_winners" WHERE "event_id" = $1 AND "game_number" = $2 AND "revoked_at" IS NULL ORDER BY "created_at" ASC, "id" ASC`;

/** Every numbered session of one event, game number ascending: `$1` event
 *  id. The finish write that numbers a session also sets its `ended_at`;
 *  `started_at` (never null) backs that column so `ended_at` reads non-null. */
export const READ_NUMBERED_SESSIONS_SQL = `SELECT "session"."id" AS "id", "session"."event_game_number" AS "event_game_number", COALESCE("session"."ended_at", "session"."started_at") AS "ended_at", "session"."play_mode" AS "play_mode" FROM "quizshow_sessions" "session" WHERE "session"."event_id" = $1 AND "session"."event_game_number" IS NOT NULL ORDER BY "session"."event_game_number" ASC`;

/** Every winner row of the given sessions, team ascending with no team last,
 *  then screen name ascending: `$1` the session ids. */
export const READ_SESSION_WINNERS_SQL = `SELECT "winner"."id" AS "id", "winner"."session_id" AS "session_id", "winner"."user_id" AS "user_id", "winner"."screen_name" AS "screen_name", "winner"."team_name" AS "team_name", "winner"."revoked_at" AS "revoked_at", "winner"."revoke_reason" AS "revoke_reason", "winner"."revoked_by_id" AS "revoked_by_id" FROM "quiz_game_winners" "winner" WHERE "winner"."session_id" = ANY($1::uuid[]) ORDER BY "winner"."team_name" ASC NULLS LAST, "winner"."screen_name" ASC, "winner"."id" ASC`;

/** Every live win of the given sessions with its badge chip columns, oldest
 *  first: `$1` the session ids. */
export const READ_SESSION_WINS_SQL = `SELECT "win"."id" AS "win_id", "win"."session_id" AS "session_id", "win"."user_id" AS "user_id", "win"."won_at" AS "won_at", "definition"."id" AS "id", "definition"."badge_key" AS "badge_key", "definition"."name_en" AS "name_en", "definition"."name_pt" AS "name_pt", "definition"."icon_key" AS "icon_key", "definition"."tint" AS "tint", "definition"."rarity" AS "rarity", "definition"."archived_at" AS "archived_at" FROM "quiz_badge_wins" "win" JOIN "quiz_badge_definitions" "definition" ON "definition"."id" = "win"."badge_definition_id" WHERE "win"."session_id" = ANY($1::uuid[]) ORDER BY "win"."won_at" ASC, "win"."id" ASC`;

/** One winner row of one event: `$1` winner id, `$2` event id. */
export const READ_EVENT_WINNER_SQL = `SELECT "id", "user_id", "revoked_at" FROM "quiz_game_winners" WHERE "id" = $1 AND "event_id" = $2`;

/** The revoke time of one revoked winner row, read after a guarded revoke
 *  matched nothing: `$1` winner id. No row means the winner row is gone. */
export const READ_WINNER_REVOKED_AT_SQL = `SELECT "revoked_at" FROM "quiz_game_winners" WHERE "id" = $1 AND "revoked_at" IS NOT NULL`;

type QuizEventStatus = QuizEventSearchRowDTO['status'];

interface SearchEventRow {
  id: string;
  slug: string;
  title: string;
  start_at: Date | string;
  status: QuizEventStatus;
  is_adults_only: boolean | null;
  configured_game_count: number | string;
  finished_game_count: number | string;
  total: number | string;
}

interface BadgeEventRow {
  id: string;
  slug: string;
  title: string;
  start_at: Date | string;
  status: QuizEventStatus;
  visibility: string;
  is_adults_only: boolean | null;
  has_quiz: boolean;
}

/** The event row a setup or revoke reads, mapped. */
interface BadgeEvent {
  id: string;
  slug: string;
  title: string;
  startAt: string;
  status: QuizEventStatus;
  isPublic: boolean;
  /** Public and published right now: the `event_was_public` snapshot of a
   *  win written after the game. */
  isPublicAndPublished: boolean;
  isAdultsOnly: boolean;
  hasQuiz: boolean;
}

interface SetupDefinitionRow {
  id: string;
  badge_key: string;
  name_en: string;
  name_pt: string | null;
  archived_at: Date | string | null;
}

interface ChipColumns {
  id: string;
  badge_key: string;
  name_en: string;
  name_pt: string | null;
  icon_key: string;
  tint: BadgeTint;
  rarity: BadgeRarity;
  archived_at: Date | string | null;
}

interface EventSlotRow extends ChipColumns {
  slot_id: string;
  game_number: number;
}

interface NumberedGameSessionRow {
  id: string;
  rounds: { contentLabel: QuizshowContentLabel }[] | null;
}

interface LiveGameWinnerRow {
  id: string;
  session_id: string | null;
  user_id: string;
  finished_at: Date | string;
}

interface EligibleUserRow {
  id: string;
}

interface NumberedSessionRow {
  id: string;
  event_game_number: number;
  ended_at: Date | string;
  play_mode: QuizshowPlayMode;
}

interface SessionWinnerRow {
  id: string;
  session_id: string;
  user_id: string;
  screen_name: string;
  team_name: string | null;
  revoked_at: Date | string | null;
  revoke_reason: string | null;
  revoked_by_id: string | null;
}

interface SessionWinRow extends ChipColumns {
  win_id: string;
  session_id: string;
  user_id: string;
  won_at: Date | string;
}

interface EventWinnerRow {
  id: string;
  user_id: string;
  revoked_at: Date | string | null;
}

interface WinnerRevokedAtRow {
  revoked_at: Date | string;
}

/** One game of a setup body after the checks: its badges in body order. */
interface RequestedGame {
  gameNumber: number;
  definitionIds: string[];
}

/** One badge to give one live winner of a finished game after the game. */
interface AddedBadgeAwardStep {
  badgeKey: string;
  definition: SetupDefinitionRow;
  winner: LiveGameWinnerRow;
  sessionId: string;
  gameNumber: number;
  eventWasAdultsOnly: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isoOf(value: Date | string): string {
  return new Date(value).toISOString();
}

function isoOrNullOf(value: Date | string | null): string | null {
  return value === null ? null : isoOf(value);
}

function chipOf(row: ChipColumns): QuizWinBadgeChip {
  return quizWinBadgeChipOf({
    id: row.id,
    badgeKey: row.badge_key,
    nameEn: row.name_en,
    namePt: row.name_pt,
    iconKey: row.icon_key,
    tint: row.tint,
    rarity: row.rarity,
    archivedAt: row.archived_at === null ? null : new Date(row.archived_at),
  });
}

function slotKeyOf(gameNumber: number, definitionId: string): string {
  return `${gameNumber}:${definitionId}`;
}

/** Cuts a text to its first `maxLength` code points. */
function cutToCodePoints(value: string, maxLength: number): string {
  return [...value].slice(0, maxLength).join('');
}

/**
 * Quiz win badges, routes 7 to 10: the admin event search, the per-event badge
 * setup read and save (with the after-the-game award), and the whole-game
 * revoke. Every write runs in one transaction under the event lock, and the
 * earned notifications go out after the commit.
 */
@Injectable()
export class QuizEventBadgesService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly awarding: QuizBadgeAwardingService,
    private readonly modAudit: ModAuditService,
  ) {}

  /** Route 7: events with a quiz whose title holds `query`, 20 a page. */
  async searchEvents(
    query: string | undefined,
    page: string | undefined,
  ): Promise<Paginated<QuizEventSearchRowDTO>> {
    const term = cutToCodePoints(
      (query ?? '').trim(),
      QUIZ_EVENT_SEARCH_MAX_LENGTH,
    );
    const pageNumber = Math.min(
      normalizePage(Number.parseInt(page ?? '', 10)),
      MAX_PAGE,
    );
    const rows = returnedRowsOf<SearchEventRow>(
      await this.dataSource.query(SEARCH_QUIZ_EVENTS_SQL, [
        escapeLikeTerm(term),
        (pageNumber - 1) * PAGE_SIZE,
      ]),
    );
    return {
      items: rows.map((row) => ({
        eventId: row.id,
        slug: row.slug,
        title: row.title,
        startAt: isoOf(row.start_at),
        status: row.status,
        isAdultsOnly: row.is_adults_only === true,
        configuredGameCount: Number(row.configured_game_count),
        finishedGameCount: Number(row.finished_game_count),
      })),
      total: Number(rows[0]?.total ?? 0),
      page: pageNumber,
      pageSize: PAGE_SIZE,
    };
  }

  /** Route 9: the five game slots and every finished game with its winners. */
  async getSetup(eventId: string): Promise<QuizEventBadgeSetupDTO> {
    const event = await this.loadEventWithQuiz(eventId);

    const slotRows = returnedRowsOf<EventSlotRow>(
      await this.dataSource.query(READ_EVENT_SLOTS_SQL, [event.id]),
    );
    const sessionRows = returnedRowsOf<NumberedSessionRow>(
      await this.dataSource.query(READ_NUMBERED_SESSIONS_SQL, [event.id]),
    );
    const sessionIds = sessionRows.map((session) => session.id);
    const winnerRows =
      sessionIds.length === 0
        ? []
        : returnedRowsOf<SessionWinnerRow>(
            await this.dataSource.query(READ_SESSION_WINNERS_SQL, [sessionIds]),
          );
    const winRows =
      winnerRows.length === 0
        ? []
        : returnedRowsOf<SessionWinRow>(
            await this.dataSource.query(READ_SESSION_WINS_SQL, [sessionIds]),
          );

    const memberUserIds = new Set<string>();
    for (const winner of winnerRows) {
      memberUserIds.add(winner.user_id);
      if (winner.revoked_by_id !== null) {
        memberUserIds.add(winner.revoked_by_id);
      }
    }
    const memberByUserId = await new MemberLookup(this.profiles).byUserIds(
      [...memberUserIds],
      { inactive: 'include' },
    );

    const finishedGameNumbers = new Set(
      sessionRows.map((session) => Number(session.event_game_number)),
    );
    const games = Array.from(
      { length: QUIZ_EVENT_GAME_SLOTS_MAX },
      (_unused, index) => {
        const gameNumber = index + 1;
        return {
          gameNumber,
          badges: slotRows
            .filter((slot) => Number(slot.game_number) === gameNumber)
            .map(chipOf),
          isFinished: finishedGameNumbers.has(gameNumber),
        };
      },
    );

    const finishedGames: QuizFinishedGameDTO[] = sessionRows.map((session) => ({
      gameNumber: Number(session.event_game_number),
      sessionId: session.id,
      finishedAt: isoOf(session.ended_at),
      playMode: session.play_mode,
      winners: winnerRows
        .filter((winner) => winner.session_id === session.id)
        .map((winner): QuizGameWinnerDTO => ({
          winnerId: winner.id,
          screenName: winner.screen_name,
          teamName: winner.team_name,
          member: memberByUserId.get(winner.user_id) ?? null,
          wins: winRows
            .filter(
              (win) =>
                win.session_id === session.id && win.user_id === winner.user_id,
            )
            .map((win) => ({
              winId: win.win_id,
              badge: chipOf(win),
              wonAt: isoOf(win.won_at),
            })),
          isRevoked: winner.revoked_at !== null,
          revokedAt: isoOrNullOf(winner.revoked_at),
          revokeReason: winner.revoke_reason,
          revokedBy:
            winner.revoked_by_id === null
              ? null
              : (memberByUserId.get(winner.revoked_by_id) ?? null),
        })),
    }));

    const highestGameNumber = Math.max(0, ...finishedGameNumbers);
    return {
      event: {
        id: event.id,
        slug: event.slug,
        title: event.title,
        startAt: event.startAt,
        status: event.status,
        isAdultsOnly: event.isAdultsOnly,
        isPublic: event.isPublic,
      },
      nextGameNumber: highestGameNumber + 1,
      limits: {
        gameSlotsMax: QUIZ_EVENT_GAME_SLOTS_MAX,
        badgesPerGameMax: QUIZ_BADGES_PER_GAME_MAX,
      },
      games,
      finishedGames,
    };
  }

  /**
   * Route 8: replaces the whole badge setup of the event. Added badges of a
   * finished game go to its live, eligible winners at once, with one audit
   * row per new win, and the earned notifications go out after the commit.
   */
  async saveSetup(
    actorId: string,
    eventId: string,
    body: QuizEventBadgeSetupInputDto,
  ): Promise<QuizEventBadgeSetupSaveResponse> {
    const event = await this.loadEventWithQuiz(eventId);
    const requestedGames = this.requestedGamesOf(body);

    const requestedDefinitionIds = requestedGames.flatMap(
      (game) => game.definitionIds,
    );
    for (const definitionId of requestedDefinitionIds) {
      if (!isUUID(definitionId)) {
        throw quizWinBadgeError('quiz_badge_not_found', { definitionId });
      }
    }
    const definitionRows =
      requestedDefinitionIds.length === 0
        ? []
        : returnedRowsOf<SetupDefinitionRow>(
            await this.dataSource.query(READ_SETUP_DEFINITIONS_SQL, [
              [...new Set(requestedDefinitionIds)],
            ]),
          );
    const definitionById = new Map(
      definitionRows.map((definition) => [definition.id, definition]),
    );
    for (const definitionId of requestedDefinitionIds) {
      if (!definitionById.has(definitionId)) {
        throw quizWinBadgeError('quiz_badge_not_found', { definitionId });
      }
    }
    const slotRowsBefore = returnedRowsOf<EventSlotRow>(
      await this.dataSource.query(READ_EVENT_SLOTS_SQL, [event.id]),
    );
    this.assertArchivedStayWhereHeld(
      requestedGames,
      definitionById,
      slotRowsBefore,
    );

    const newWins = await this.dataSource.transaction(async (manager) => {
      await manager.query(QUIZ_EVENT_BADGES_LOCK_SQL, [event.id]);
      const lockedDefinitionById = await this.readLockedDefinitions(
        manager,
        requestedDefinitionIds,
      );
      const currentSlots = returnedRowsOf<EventSlotRow>(
        await manager.query(READ_EVENT_SLOTS_SQL, [event.id]),
      );
      this.assertArchivedStayWhereHeld(
        requestedGames,
        lockedDefinitionById,
        currentSlots,
      );

      const requestedSlotKeys = new Set(
        requestedGames.flatMap((game) =>
          game.definitionIds.map((definitionId) =>
            slotKeyOf(game.gameNumber, definitionId),
          ),
        ),
      );
      const currentSlotKeys = new Set(
        currentSlots.map((slot) =>
          slotKeyOf(Number(slot.game_number), slot.id),
        ),
      );

      for (const slot of currentSlots) {
        const gameNumber = Number(slot.game_number);
        if (requestedSlotKeys.has(slotKeyOf(gameNumber, slot.id))) continue;
        await manager.query(DELETE_EVENT_SLOT_SQL, [slot.slot_id]);
        await this.writeSlotAudit(
          manager,
          actorId,
          QUIZ_BADGE_AUDIT_ACTIONS.detached,
          slot.name_en,
          slot.id,
          gameNumber,
          event.id,
        );
      }

      const addedGames: RequestedGame[] = [];
      for (const game of requestedGames) {
        const addedDefinitionIds = game.definitionIds.filter(
          (definitionId) =>
            !currentSlotKeys.has(slotKeyOf(game.gameNumber, definitionId)),
        );
        for (const definitionId of addedDefinitionIds) {
          await manager.query(INSERT_EVENT_SLOT_SQL, [
            event.id,
            game.gameNumber,
            definitionId,
            actorId,
          ]);
          await this.writeSlotAudit(
            manager,
            actorId,
            QUIZ_BADGE_AUDIT_ACTIONS.attached,
            lockedDefinitionById.get(definitionId)?.name_en ?? '',
            definitionId,
            game.gameNumber,
            event.id,
          );
        }
        if (addedDefinitionIds.length > 0) {
          addedGames.push({
            gameNumber: game.gameNumber,
            definitionIds: addedDefinitionIds,
          });
        }
      }

      return this.awardAddedBadges(
        manager,
        actorId,
        event,
        addedGames,
        lockedDefinitionById,
      );
    });

    if (newWins.length > 0) {
      await this.awarding.notifyNewWins(newWins);
    }
    return {
      setup: await this.getSetup(event.id),
      awardedWinCount: newWins.length,
    };
  }

  /**
   * Route 10: revokes one member's win of one whole game, with every badge
   * that game gave them. Final, audited with the reason, and notifies nobody.
   */
  async revokeWinner(
    actorId: string,
    eventId: string,
    winnerId: string,
    body: QuizGameWinRevokeInputDto,
  ): Promise<QuizGameWinRevokeResponse> {
    const event = await this.loadEvent(eventId);
    if (!isUUID(winnerId)) {
      throw quizWinBadgeError('quiz_badge_winner_not_found');
    }
    const winner = returnedRowsOf<EventWinnerRow>(
      await this.dataSource.query(READ_EVENT_WINNER_SQL, [winnerId, event.id]),
    )[0];
    if (!winner) {
      throw quizWinBadgeError('quiz_badge_winner_not_found');
    }
    if (winner.revoked_at !== null) {
      throw quizWinBadgeError('quiz_badge_winner_already_revoked', {
        revokedAt: isoOf(winner.revoked_at),
      });
    }
    const reason = this.revokeReasonOf(body);

    return this.dataSource.transaction(async (manager) => {
      await manager.query(QUIZ_EVENT_BADGES_LOCK_SQL, [event.id]);
      const outcome = await this.awarding.revokeGameWin(manager, {
        winnerId: winner.id,
        actorId,
        reason,
      });
      if (outcome === null) {
        const revokedRow = returnedRowsOf<WinnerRevokedAtRow>(
          await manager.query(READ_WINNER_REVOKED_AT_SQL, [winner.id]),
        )[0];
        if (!revokedRow) {
          throw quizWinBadgeError('quiz_badge_winner_not_found');
        }
        throw quizWinBadgeError('quiz_badge_winner_already_revoked', {
          revokedAt: isoOf(revokedRow.revoked_at),
        });
      }
      await this.modAudit.writeAuditLog(
        null,
        actorId,
        QUIZ_BADGE_AUDIT_ACTIONS.gameWinRevoked,
        undefined,
        `${winner.id}: ${reason}`,
        undefined,
        manager,
        outcome.userId,
      );
      return {
        winnerId: winner.id,
        revokedBadgeKeys: outcome.revokedBadgeKeys,
        removedAwardKeys: outcome.removedAwardKeys,
      };
    });
  }

  /**
   * Re-reads the requested definitions under the event lock with a share lock
   * on each row. An id whose definition was deleted since the first read
   * answers `quiz_badge_not_found` with that id, before any slot write.
   */
  private async readLockedDefinitions(
    manager: EntityManager,
    requestedDefinitionIds: readonly string[],
  ): Promise<Map<string, SetupDefinitionRow>> {
    if (requestedDefinitionIds.length === 0) return new Map();
    const lockedRows = returnedRowsOf<SetupDefinitionRow>(
      await manager.query(READ_SETUP_DEFINITIONS_FOR_SHARE_SQL, [
        [...new Set(requestedDefinitionIds)],
      ]),
    );
    const lockedDefinitionById = new Map(
      lockedRows.map((definition) => [definition.id, definition]),
    );
    for (const definitionId of requestedDefinitionIds) {
      if (!lockedDefinitionById.has(definitionId)) {
        throw quizWinBadgeError('quiz_badge_not_found', { definitionId });
      }
    }
    return lockedDefinitionById;
  }

  /** The event of a setup route: unknown or malformed answers
   *  `quiz_badge_event_not_found`, an event with no quiz answers
   *  `quiz_badge_event_has_no_quiz`. */
  private async loadEventWithQuiz(eventId: string): Promise<BadgeEvent> {
    const event = await this.loadEvent(eventId);
    if (!event.hasQuiz) {
      throw quizWinBadgeError('quiz_badge_event_has_no_quiz');
    }
    return event;
  }

  /** The event of a route: unknown or malformed answers
   *  `quiz_badge_event_not_found`. */
  private async loadEvent(eventId: string): Promise<BadgeEvent> {
    if (!isUUID(eventId)) {
      throw quizWinBadgeError('quiz_badge_event_not_found');
    }
    const row = returnedRowsOf<BadgeEventRow>(
      await this.dataSource.query(LOAD_QUIZ_BADGE_EVENT_SQL, [eventId]),
    )[0];
    if (!row) {
      throw quizWinBadgeError('quiz_badge_event_not_found');
    }
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      startAt: isoOf(row.start_at),
      status: row.status,
      isPublic: row.visibility === 'public',
      isPublicAndPublished:
        row.visibility === 'public' && row.status === 'published',
      isAdultsOnly: row.is_adults_only === true,
      hasQuiz: row.has_quiz === true,
    };
  }

  /**
   * The shape checks of a setup body, in contract order: the body, each
   * entry and its game number, then (after repeated game numbers merge) each
   * id list, a badge once per game, and at most three badges per game.
   */
  private requestedGamesOf(body: unknown): RequestedGame[] {
    const games: unknown = isPlainObject(body) ? body.games : undefined;
    if (!Array.isArray(games)) {
      throw quizWinBadgeError('quiz_badge_setup_invalid');
    }
    const entries: unknown[] = games;
    const checkedEntries: {
      gameNumber: number;
      entry: Record<string, unknown>;
    }[] = [];
    for (const entry of entries) {
      if (!isPlainObject(entry)) {
        throw quizWinBadgeError('quiz_badge_setup_invalid');
      }
      const gameNumber = entry.gameNumber;
      if (
        typeof gameNumber !== 'number' ||
        !Number.isInteger(gameNumber) ||
        gameNumber < 1
      ) {
        throw quizWinBadgeError('quiz_badge_game_number_invalid', {
          gameNumber: typeof gameNumber === 'number' ? gameNumber : undefined,
        });
      }
      if (gameNumber > QUIZ_EVENT_GAME_SLOTS_MAX) {
        throw quizWinBadgeError('quiz_badge_game_limit_reached', {
          limit: QUIZ_EVENT_GAME_SLOTS_MAX,
        });
      }
      checkedEntries.push({ gameNumber, entry });
    }

    const definitionIdsByGame = new Map<number, string[]>();
    for (const { gameNumber, entry } of checkedEntries) {
      const definitionIds = entry.badgeDefinitionIds;
      if (
        !Array.isArray(definitionIds) ||
        !definitionIds.every((definitionId) => typeof definitionId === 'string')
      ) {
        throw quizWinBadgeError('quiz_badge_setup_invalid');
      }
      const textDefinitionIds: string[] = definitionIds;
      definitionIdsByGame.set(gameNumber, [
        ...(definitionIdsByGame.get(gameNumber) ?? []),
        ...textDefinitionIds.map((definitionId) => definitionId.toLowerCase()),
      ]);
    }

    const requestedGames: RequestedGame[] = [];
    for (const [gameNumber, definitionIds] of definitionIdsByGame) {
      const seenDefinitionIds = new Set<string>();
      for (const definitionId of definitionIds) {
        if (seenDefinitionIds.has(definitionId)) {
          throw quizWinBadgeError('quiz_badge_slot_duplicate', {
            gameNumber,
            definitionId,
          });
        }
        seenDefinitionIds.add(definitionId);
      }
      if (definitionIds.length > QUIZ_BADGES_PER_GAME_MAX) {
        throw quizWinBadgeError('quiz_badge_slot_limit_reached', {
          limit: QUIZ_BADGES_PER_GAME_MAX,
          gameNumber,
        });
      }
      requestedGames.push({ gameNumber, definitionIds });
    }
    return requestedGames.sort(
      (first, second) => first.gameNumber - second.gameNumber,
    );
  }

  /** An archived definition may stay only in a game that already holds it. */
  private assertArchivedStayWhereHeld(
    requestedGames: readonly RequestedGame[],
    definitionById: ReadonlyMap<string, SetupDefinitionRow>,
    slotRows: readonly EventSlotRow[],
  ): void {
    const heldSlotKeys = new Set(
      slotRows.map((slot) => slotKeyOf(Number(slot.game_number), slot.id)),
    );
    for (const game of requestedGames) {
      for (const definitionId of game.definitionIds) {
        const archivedAt = definitionById.get(definitionId)?.archived_at;
        const isArchived = archivedAt !== null && archivedAt !== undefined;
        if (
          isArchived &&
          !heldSlotKeys.has(slotKeyOf(game.gameNumber, definitionId))
        ) {
          throw quizWinBadgeError('quiz_badge_archived', { definitionId });
        }
      }
    }
  }

  /**
   * Gives the badges just attached to finished games to their live winners.
   * Every award step of the save runs in badge key order, then member id
   * order, so the award locks of two transactions are always taken in the
   * same order. Writes one audit row per new win and answers the new wins.
   */
  private async awardAddedBadges(
    manager: EntityManager,
    actorId: string,
    event: BadgeEvent,
    addedGames: readonly RequestedGame[],
    definitionById: ReadonlyMap<string, SetupDefinitionRow>,
  ): Promise<QuizBadgeNewWin[]> {
    const awardSteps: AddedBadgeAwardStep[] = [];
    for (const addedGame of addedGames) {
      awardSteps.push(
        ...(await this.awardStepsOfGame(
          manager,
          event,
          addedGame,
          definitionById,
        )),
      );
    }
    awardSteps.sort(
      (first, second) =>
        first.badgeKey.localeCompare(second.badgeKey) ||
        first.winner.user_id.localeCompare(second.winner.user_id) ||
        first.gameNumber - second.gameNumber,
    );

    const newWins: QuizBadgeNewWin[] = [];
    for (const step of awardSteps) {
      const { definition, winner } = step;
      const newWin = await this.awarding.awardWin(manager, {
        definition: {
          id: definition.id,
          badgeKey: definition.badge_key,
          nameEn: definition.name_en,
          namePt: definition.name_pt,
        },
        userId: winner.user_id,
        eventId: event.id,
        sessionId: step.sessionId,
        gameNumber: step.gameNumber,
        eventName: event.title,
        eventWasPublic: event.isPublicAndPublished,
        eventWasAdultsOnly: step.eventWasAdultsOnly,
        wonAt: new Date(winner.finished_at),
      });
      if (newWin === null) continue;
      newWins.push(newWin);
      await this.modAudit.writeAuditLog(
        null,
        actorId,
        QUIZ_BADGE_AUDIT_ACTIONS.awardedAfterGame,
        undefined,
        quizBadgeAuditNote(
          definition.name_en,
          definition.id,
          step.gameNumber,
          event.id,
        ),
        undefined,
        manager,
        winner.user_id,
      );
    }
    return newWins;
  }

  /**
   * The award steps of the badges just attached to one game, when the game
   * has a numbered session. A revoked winner is left out by the winners read
   * and a missing or suspended account by the eligibility read.
   */
  private async awardStepsOfGame(
    manager: EntityManager,
    event: BadgeEvent,
    addedGame: RequestedGame,
    definitionById: ReadonlyMap<string, SetupDefinitionRow>,
  ): Promise<AddedBadgeAwardStep[]> {
    const session = returnedRowsOf<NumberedGameSessionRow>(
      await manager.query(READ_NUMBERED_GAME_SESSION_SQL, [
        event.id,
        addedGame.gameNumber,
      ]),
    )[0];
    if (!session) return [];

    const liveWinners = returnedRowsOf<LiveGameWinnerRow>(
      await manager.query(READ_LIVE_GAME_WINNERS_SQL, [
        event.id,
        addedGame.gameNumber,
      ]),
    );
    if (liveWinners.length === 0) return [];
    const eligibleUserIds = new Set(
      returnedRowsOf<EligibleUserRow>(
        await manager.query(ELIGIBLE_WINNER_USER_IDS_SQL, [
          [...new Set(liveWinners.map((winner) => winner.user_id))],
        ]),
      ).map((eligibleUser) => eligibleUser.id),
    );
    const eligibleWinners = liveWinners.filter(
      (winner) =>
        winner.session_id !== null && eligibleUserIds.has(winner.user_id),
    );
    if (eligibleWinners.length === 0) return [];

    const eventWasAdultsOnly = isAdultsOnlySession(event.isAdultsOnly, {
      rounds: Array.isArray(session.rounds) ? session.rounds : [],
    });
    const awardSteps: AddedBadgeAwardStep[] = [];
    for (const definitionId of addedGame.definitionIds) {
      const definition = definitionById.get(definitionId);
      if (!definition) continue;
      for (const winner of eligibleWinners) {
        awardSteps.push({
          badgeKey: quizBadgeKeyOf(definition.id),
          definition,
          winner,
          sessionId: winner.session_id as string,
          gameNumber: addedGame.gameNumber,
          eventWasAdultsOnly,
        });
      }
    }
    return awardSteps;
  }

  /** One attach or detach audit row, with no member as target. */
  private async writeSlotAudit(
    manager: EntityManager,
    actorId: string,
    action: string,
    nameEn: string,
    definitionId: string,
    gameNumber: number,
    eventId: string,
  ): Promise<void> {
    await this.modAudit.writeAuditLog(
      null,
      actorId,
      action,
      undefined,
      quizBadgeAuditNote(nameEn, definitionId, gameNumber, eventId),
      undefined,
      manager,
      null,
    );
  }

  /** The revoke reason after sanitising and trimming: 1 to 300 code points. */
  private revokeReasonOf(body: QuizGameWinRevokeInputDto): string {
    const rawReason: unknown = isPlainObject(body) ? body.reason : undefined;
    const reason =
      typeof rawReason === 'string'
        ? (toStoredPlainTextOrNull(rawReason) ?? '').trim()
        : '';
    if (reason.length === 0) {
      throw quizWinBadgeError('quiz_badge_revoke_reason_required');
    }
    if (codePointLength(reason) > QUIZ_REVOKE_REASON_MAX_LENGTH) {
      throw quizWinBadgeError('quiz_badge_revoke_reason_too_long', {
        maxLength: QUIZ_REVOKE_REASON_MAX_LENGTH,
      });
    }
    return reason;
  }
}
