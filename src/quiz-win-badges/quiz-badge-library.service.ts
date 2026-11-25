import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  codePointLength,
  isCommunityBadgeIconKey,
  type CommunityBadgeIconKey,
} from '../community-badges/community-badges.catalog';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { toStoredPlainTextOrNull } from '../communities/community-plain-text';
import { ModAuditService } from '../moderation/mod-audit.service';
import {
  BADGE_CATALOG,
  SEASONAL_BADGE_CATALOG,
  type BadgeRarity,
  type BadgeTint,
} from '../recognition/recognition.catalog';
import { returnedRowsOf } from './quiz-badge-awarding.service';
import {
  QUIZ_BADGE_AUDIT_ACTIONS,
  QUIZ_EVENT_BADGES_LOCK_SQL,
  quizBadgeAuditNote,
  quizBadgeDefinitionAuditNote,
  quizWinBadgeError,
} from './quiz-win-badges.constants';
import {
  QUIZ_BADGE_DESCRIPTION_MAX_LENGTH,
  QUIZ_BADGE_NAME_MAX_LENGTH,
  QUIZ_BADGE_RARITIES,
  QUIZ_BADGE_TINTS,
  quizBadgeKeyOf,
  type QuizBadgeDefinitionDTO,
  type QuizBadgeLibraryResponse,
} from './quiz-win-badges.contract';
import type { QuizBadgeDefinitionInputDto } from './dto/quiz-win-badges.dto';

/** The unique index on the lowercase English name. */
const NAME_EN_UNIQUE_CONSTRAINT = 'UQ_quiz_badge_definitions_name_en';

/** The unique index on the lowercase Portuguese name. */
const NAME_PT_UNIQUE_CONSTRAINT = 'UQ_quiz_badge_definitions_name_pt';

/** Postgres error code of a unique violation. */
const UNIQUE_VIOLATION_CODE = '23505';

/** Postgres error code of a foreign key violation. */
const FOREIGN_KEY_VIOLATION_CODE = '23503';

/** Every English name a code badge already uses, lowercase. */
const CODE_BADGE_NAMES_LOWERCASE: ReadonlySet<string> = new Set(
  [...BADGE_CATALOG, ...SEASONAL_BADGE_CATALOG].map((entry) =>
    entry.name.toLowerCase(),
  ),
);

/**
 * Every column of a definition row plus its three counts. The counts come from
 * two lateral aggregates (each always yields one row): `holder_count` distinct
 * members with a live win, `win_count` live win rows, `event_count` distinct
 * events whose slots use the badge. Append a `WHERE` or `ORDER BY` clause.
 */
const DEFINITION_WITH_COUNTS_SQL = `SELECT "definition"."id", "definition"."badge_key", "definition"."name_en", "definition"."name_pt", "definition"."description_en", "definition"."description_pt", "definition"."icon_key", "definition"."tint", "definition"."rarity", "definition"."archived_at", "definition"."created_at", "definition"."updated_at", "win_counts"."holder_count", "win_counts"."win_count", "slot_counts"."event_count" FROM "quiz_badge_definitions" "definition" LEFT JOIN LATERAL (SELECT COUNT(DISTINCT "win"."user_id")::int AS "holder_count", COUNT(*)::int AS "win_count" FROM "quiz_badge_wins" "win" WHERE "win"."badge_definition_id" = "definition"."id") "win_counts" ON true LEFT JOIN LATERAL (SELECT COUNT(DISTINCT "slot"."event_id")::int AS "event_count" FROM "quiz_event_badge_slots" "slot" WHERE "slot"."badge_definition_id" = "definition"."id") "slot_counts" ON true`;

/** The library read: live badges first, then archived ones, each by English name. */
export const LIST_QUIZ_BADGE_LIBRARY_SQL = `${DEFINITION_WITH_COUNTS_SQL} ORDER BY ("definition"."archived_at" IS NOT NULL) ASC, "definition"."name_en" ASC, "definition"."id" ASC LIMIT ${DEFAULT_LIST_LIMIT}`;

/** One definition with its counts: `$1` definition id. */
export const READ_QUIZ_BADGE_DEFINITION_SQL = `${DEFINITION_WITH_COUNTS_SQL} WHERE "definition"."id" = $1`;

/** Inserts a definition with its generated id and the key derived from it:
 *  `$1` id, `$2` badge key, `$3` English name, `$4` Portuguese name, `$5`
 *  English description, `$6` Portuguese description, `$7` icon key, `$8` tint,
 *  `$9` rarity, `$10` creating admin. */
export const INSERT_QUIZ_BADGE_DEFINITION_SQL = `INSERT INTO "quiz_badge_definitions" ("id", "badge_key", "name_en", "name_pt", "description_en", "description_pt", "icon_key", "tint", "rarity", "created_by_id") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING "id", "badge_key", "name_en", "name_pt", "description_en", "description_pt", "icon_key", "tint", "rarity", "archived_at", "created_at", "updated_at"`;

/** Whether another definition already uses the English name, case ignored:
 *  `$1` name, `$2` the definition to leave out. */
export const ENGLISH_NAME_TAKEN_SQL = `SELECT 1 AS "found" FROM "quiz_badge_definitions" WHERE lower("name_en") = lower($1) AND "id" <> $2 LIMIT 1`;

/** Whether another definition already uses the Portuguese name, case ignored:
 *  `$1` name, `$2` the definition to leave out. */
export const PORTUGUESE_NAME_TAKEN_SQL = `SELECT 1 AS "found" FROM "quiz_badge_definitions" WHERE lower("name_pt") = lower($1) AND "id" <> $2 LIMIT 1`;

/** Archives a live definition once: `$1` definition id. */
export const ARCHIVE_QUIZ_BADGE_DEFINITION_SQL = `UPDATE "quiz_badge_definitions" SET "archived_at" = now(), "updated_at" = now() WHERE "id" = $1 AND "archived_at" IS NULL RETURNING "name_en"`;

/** Restores an archived definition once: `$1` definition id. */
export const RESTORE_QUIZ_BADGE_DEFINITION_SQL = `UPDATE "quiz_badge_definitions" SET "archived_at" = NULL, "updated_at" = now() WHERE "id" = $1 AND "archived_at" IS NOT NULL RETURNING "name_en"`;

/** The id and English name of one definition: `$1` definition id. */
export const READ_DEFINITION_IDENTITY_SQL = `SELECT "id", "name_en" FROM "quiz_badge_definitions" WHERE "id" = $1`;

/** Live holders and live win rows of one definition: `$1` definition id. */
export const READ_DEFINITION_WIN_COUNTS_SQL = `SELECT COUNT(DISTINCT "user_id")::int AS "holder_count", COUNT(*)::int AS "win_count" FROM "quiz_badge_wins" WHERE "badge_definition_id" = $1`;

/** Every event whose slots use one definition: `$1` definition id. */
export const READ_DEFINITION_EVENT_IDS_SQL = `SELECT DISTINCT "event_id" FROM "quiz_event_badge_slots" WHERE "badge_definition_id" = $1`;

/** Serialises badge deletes, taken first in the `remove` transaction, so the
 *  passes of `lockAttachedEvents` of two deletes cannot take event locks in
 *  crossing orders and deadlock. */
export const QUIZ_BADGE_DELETE_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('quiz_badge_definition_delete'))";

/** Deletes every slot row of one definition: `$1` definition id. */
export const DELETE_DEFINITION_SLOTS_SQL = `DELETE FROM "quiz_event_badge_slots" WHERE "badge_definition_id" = $1 RETURNING "event_id", "game_number"`;

/** Deletes the award rows of one badge key (orphans of a failed revoke):
 *  `$1` badge key. */
export const DELETE_DEFINITION_AWARDS_SQL = `DELETE FROM "recognition_awards" WHERE "badge_key" = $1`;

/** Deletes one definition: `$1` definition id. */
export const DELETE_QUIZ_BADGE_DEFINITION_SQL = `DELETE FROM "quiz_badge_definitions" WHERE "id" = $1 RETURNING "id"`;

interface DefinitionRow {
  id: string;
  badge_key: string;
  name_en: string;
  name_pt: string | null;
  description_en: string;
  description_pt: string | null;
  icon_key: CommunityBadgeIconKey;
  tint: BadgeTint;
  rarity: BadgeRarity;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  holder_count?: number | string;
  win_count?: number | string;
  event_count?: number | string;
}

interface DefinitionIdentityRow {
  id: string;
  name_en: string;
}

interface WinCountsRow {
  holder_count: number | string;
  win_count: number | string;
}

interface EventIdRow {
  event_id: string;
}

interface DeletedSlotRow {
  event_id: string;
  game_number: number;
}

interface NamedRow {
  name_en: string;
}

type TextFieldName = 'name' | 'description';

type TextObject = Record<string, unknown>;

/** The fields a body changes, each already checked. A key the body did not
 *  carry is absent. */
interface NormalizedDefinitionFields {
  nameEn?: string;
  namePt?: string | null;
  descriptionEn?: string;
  descriptionPt?: string | null;
  iconKey?: CommunityBadgeIconKey;
  tint?: BadgeTint;
  rarity?: BadgeRarity;
}

/** Column behind each normalised field, in the order a PATCH writes them. */
const FIELD_COLUMNS: readonly (readonly [
  keyof NormalizedDefinitionFields,
  string,
])[] = [
  ['nameEn', 'name_en'],
  ['namePt', 'name_pt'],
  ['descriptionEn', 'description_en'],
  ['descriptionPt', 'description_pt'],
  ['iconKey', 'icon_key'],
  ['tint', 'tint'],
  ['rarity', 'rarity'],
];

function isPlainObject(value: unknown): value is TextObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toIsoString(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** The language a unique violation names, or null when the error is anything else. */
function uniqueViolationLanguage(error: unknown): 'en' | 'pt' | null {
  const candidates: unknown[] = [error];
  if (typeof error === 'object' && error !== null) {
    candidates.push((error as { driverError?: unknown }).driverError);
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const { code, constraint } = candidate as {
      code?: unknown;
      constraint?: unknown;
    };
    if (code !== UNIQUE_VIOLATION_CODE) continue;
    if (constraint === NAME_EN_UNIQUE_CONSTRAINT) return 'en';
    if (constraint === NAME_PT_UNIQUE_CONSTRAINT) return 'pt';
  }
  return null;
}

/** True when the error, or the driver error inside it, is a foreign key
 *  violation. */
function isForeignKeyViolation(error: unknown): boolean {
  const candidates: unknown[] = [error];
  if (typeof error === 'object' && error !== null) {
    candidates.push((error as { driverError?: unknown }).driverError);
  }
  return candidates.some(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { code?: unknown }).code === FOREIGN_KEY_VIOLATION_CODE,
  );
}

/** Marks a definition delete that a win row still referenced, so `remove`
 *  answers `quiz_badge_in_use` once the transaction has rolled back. */
class DefinitionStillReferencedError extends Error {}

/** Maps a definition row and its counts to the admin DTO. */
function toDefinitionDto(row: DefinitionRow): QuizBadgeDefinitionDTO {
  const winCount = Number(row.win_count ?? 0);
  return {
    id: row.id,
    badgeKey: row.badge_key,
    name: { en: row.name_en, pt: row.name_pt },
    description: { en: row.description_en, pt: row.description_pt },
    iconKey: row.icon_key,
    tint: row.tint,
    rarity: row.rarity,
    isArchived: row.archived_at !== null,
    archivedAt: row.archived_at === null ? null : toIsoString(row.archived_at),
    holderCount: Number(row.holder_count ?? 0),
    winCount,
    eventCount: Number(row.event_count ?? 0),
    canDelete: winCount === 0,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

/**
 * Quiz win badges: the staff badge library (routes 1 to 6). It lists, creates,
 * edits, archives, restores and deletes badge definitions. Editing writes no
 * audit row; archive, restore and delete do, inside the action's transaction.
 */
@Injectable()
export class QuizBadgeLibraryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly modAudit: ModAuditService,
  ) {}

  /** Route 1: every definition with its counts, live ones first. */
  async listLibrary(): Promise<QuizBadgeLibraryResponse> {
    const rows = returnedRowsOf<DefinitionRow>(
      await this.dataSource.query(LIST_QUIZ_BADGE_LIBRARY_SQL),
    );
    return { items: rows.map(toDefinitionDto) };
  }

  /** Route 2: creates a definition; every field is required. */
  async create(
    actorId: string,
    body: QuizBadgeDefinitionInputDto,
  ): Promise<QuizBadgeDefinitionDTO> {
    const fields = this.normalizeFields(body, true);
    const definitionId = randomUUID();
    await this.assertNamesAvailable(fields, definitionId);
    let rows: DefinitionRow[];
    try {
      rows = returnedRowsOf<DefinitionRow>(
        await this.dataSource.query(INSERT_QUIZ_BADGE_DEFINITION_SQL, [
          definitionId,
          quizBadgeKeyOf(definitionId),
          fields.nameEn,
          fields.namePt ?? null,
          fields.descriptionEn,
          fields.descriptionPt ?? null,
          fields.iconKey,
          fields.tint,
          fields.rarity,
          actorId,
        ]),
      );
    } catch (error) {
      throw this.refuseTakenName(error) ?? error;
    }
    const [insertedRow] = rows;
    if (!insertedRow) {
      throw quizWinBadgeError('quiz_badge_not_found', {
        definitionId,
      });
    }
    return toDefinitionDto(insertedRow);
  }

  /** Route 3: applies the fields the body carries. A `name` or `description`
   *  object replaces both languages; an empty body writes nothing. */
  async update(
    definitionId: string,
    body: QuizBadgeDefinitionInputDto,
  ): Promise<QuizBadgeDefinitionDTO> {
    this.assertDefinitionId(definitionId);
    const fields = this.normalizeFields(body, false);
    const assignments: string[] = [];
    const parameters: unknown[] = [definitionId];
    for (const [field, column] of FIELD_COLUMNS) {
      if (fields[field] === undefined) continue;
      parameters.push(fields[field]);
      assignments.push(`"${column}" = $${parameters.length}`);
    }
    if (assignments.length === 0) {
      return this.readDefinition(definitionId);
    }
    await this.assertDefinitionExists(definitionId);
    await this.assertNamesAvailable(fields, definitionId);
    let updatedRows: { id: string }[];
    try {
      updatedRows = returnedRowsOf<{ id: string }>(
        await this.dataSource.query(
          `UPDATE "quiz_badge_definitions" SET ${assignments.join(', ')}, "updated_at" = now() WHERE "id" = $1 RETURNING "id"`,
          parameters,
        ),
      );
    } catch (error) {
      throw this.refuseTakenName(error) ?? error;
    }
    if (updatedRows.length === 0) {
      throw quizWinBadgeError('quiz_badge_not_found', { definitionId });
    }
    return this.readDefinition(definitionId);
  }

  /** Route 4: archives a live definition; an archived one stays as it is. */
  async archive(
    actorId: string,
    definitionId: string,
  ): Promise<QuizBadgeDefinitionDTO> {
    return this.changeArchiveState(
      actorId,
      definitionId,
      ARCHIVE_QUIZ_BADGE_DEFINITION_SQL,
      QUIZ_BADGE_AUDIT_ACTIONS.definitionArchived,
    );
  }

  /** Route 5: restores an archived definition; a live one stays as it is. */
  async restore(
    actorId: string,
    definitionId: string,
  ): Promise<QuizBadgeDefinitionDTO> {
    return this.changeArchiveState(
      actorId,
      definitionId,
      RESTORE_QUIZ_BADGE_DEFINITION_SQL,
      QUIZ_BADGE_AUDIT_ACTIONS.definitionRestored,
    );
  }

  /**
   * Route 6: deletes a definition nobody has won. Under the lock of every
   * event that uses it, the slot rows (one detach audit row each), the orphan
   * award rows and the definition go in one transaction. A win row that still
   * blocks the definition delete (a foreign key violation) rolls it all back
   * and answers `quiz_badge_in_use` with the holder count read again after.
   */
  async remove(actorId: string, definitionId: string): Promise<void> {
    this.assertDefinitionId(definitionId);
    const identityRows = returnedRowsOf<DefinitionIdentityRow>(
      await this.dataSource.query(READ_DEFINITION_IDENTITY_SQL, [definitionId]),
    );
    const [identityRow] = identityRows;
    if (!identityRow) {
      throw quizWinBadgeError('quiz_badge_not_found', { definitionId });
    }
    const nameEn = identityRow.name_en;
    await this.assertNoWins(this.dataSource, definitionId);
    try {
      await this.deleteDefinition(actorId, definitionId, nameEn);
    } catch (error) {
      if (!(error instanceof DefinitionStillReferencedError)) throw error;
      const countRow = returnedRowsOf<WinCountsRow>(
        await this.dataSource.query(READ_DEFINITION_WIN_COUNTS_SQL, [
          definitionId,
        ]),
      )[0];
      throw quizWinBadgeError('quiz_badge_in_use', {
        holderCount: Number(countRow?.holder_count ?? 0),
      });
    }
  }

  /** The delete transaction of route 6, after the first checks passed. */
  private async deleteDefinition(
    actorId: string,
    definitionId: string,
    nameEn: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager: EntityManager) => {
      await manager.query(QUIZ_BADGE_DELETE_LOCK_SQL);
      await this.lockAttachedEvents(manager, definitionId);
      // A win written before the locks were held shows up now.
      await this.assertNoWins(manager, definitionId);
      const deletedSlots = returnedRowsOf<DeletedSlotRow>(
        await manager.query(DELETE_DEFINITION_SLOTS_SQL, [definitionId]),
      ).sort(
        (first, second) =>
          first.event_id.localeCompare(second.event_id) ||
          first.game_number - second.game_number,
      );
      for (const slot of deletedSlots) {
        await this.modAudit.writeAuditLog(
          null,
          actorId,
          QUIZ_BADGE_AUDIT_ACTIONS.detached,
          undefined,
          quizBadgeAuditNote(
            nameEn,
            definitionId,
            slot.game_number,
            slot.event_id,
          ),
          undefined,
          manager,
        );
      }
      await manager.query(DELETE_DEFINITION_AWARDS_SQL, [
        quizBadgeKeyOf(definitionId),
      ]);
      let deletedRows: { id: string }[];
      try {
        deletedRows = returnedRowsOf<{ id: string }>(
          await manager.query(DELETE_QUIZ_BADGE_DEFINITION_SQL, [definitionId]),
        );
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw new DefinitionStillReferencedError(
            `Quiz badge ${definitionId} is still referenced by a win`,
          );
        }
        throw error;
      }
      if (deletedRows.length === 0) {
        throw quizWinBadgeError('quiz_badge_not_found', { definitionId });
      }
      await this.modAudit.writeAuditLog(
        null,
        actorId,
        QUIZ_BADGE_AUDIT_ACTIONS.definitionDeleted,
        undefined,
        quizBadgeDefinitionAuditNote(nameEn, definitionId),
        undefined,
        manager,
      );
    });
  }

  /**
   * Takes the event lock of every event the badge is attached to, ascending.
   * A slot can be added while the locks are being taken, so the attached
   * events are read again after each round; events not yet held are locked
   * (ascending) and the loop repeats until a read brings nothing new. Each
   * statement reads committed rows, so a slot added by a save that held its
   * own event lock shows up in the next read.
   */
  private async lockAttachedEvents(
    manager: EntityManager,
    definitionId: string,
  ): Promise<void> {
    const lockedEventIds = new Set<string>();
    for (;;) {
      const newEventIds = returnedRowsOf<EventIdRow>(
        await manager.query(READ_DEFINITION_EVENT_IDS_SQL, [definitionId]),
      )
        .map((row) => row.event_id)
        .filter((eventId) => !lockedEventIds.has(eventId))
        .sort();
      if (newEventIds.length === 0) return;
      for (const eventId of newEventIds) {
        await manager.query(QUIZ_EVENT_BADGES_LOCK_SQL, [eventId]);
        lockedEventIds.add(eventId);
      }
    }
  }

  /** Runs the archive or restore statement and writes its audit row only when
   *  the state changed, then reads the definition back. */
  private async changeArchiveState(
    actorId: string,
    definitionId: string,
    statement: string,
    auditAction: string,
  ): Promise<QuizBadgeDefinitionDTO> {
    this.assertDefinitionId(definitionId);
    await this.dataSource.transaction(async (manager: EntityManager) => {
      const changedRows = returnedRowsOf<NamedRow>(
        await manager.query(statement, [definitionId]),
      );
      const [changedRow] = changedRows;
      if (!changedRow) return;
      await this.modAudit.writeAuditLog(
        null,
        actorId,
        auditAction,
        undefined,
        quizBadgeDefinitionAuditNote(changedRow.name_en, definitionId),
        undefined,
        manager,
      );
    });
    return this.readDefinition(definitionId);
  }

  /** Answers `quiz_badge_not_found` for a malformed id. */
  private assertDefinitionId(definitionId: string): void {
    if (!isUUID(definitionId)) {
      throw quizWinBadgeError('quiz_badge_not_found', { definitionId });
    }
  }

  /** Answers `quiz_badge_not_found` when the definition is gone. */
  private async assertDefinitionExists(definitionId: string): Promise<void> {
    const [identityRow] = returnedRowsOf<DefinitionIdentityRow>(
      await this.dataSource.query(READ_DEFINITION_IDENTITY_SQL, [definitionId]),
    );
    if (!identityRow) {
      throw quizWinBadgeError('quiz_badge_not_found', { definitionId });
    }
  }

  /** Answers `quiz_badge_in_use` with the holder count while a win row exists. */
  private async assertNoWins(
    runner: Pick<EntityManager, 'query'>,
    definitionId: string,
  ): Promise<void> {
    const countRows = returnedRowsOf<WinCountsRow>(
      await runner.query(READ_DEFINITION_WIN_COUNTS_SQL, [definitionId]),
    );
    const [countRow] = countRows;
    if (countRow && Number(countRow.win_count) > 0) {
      throw quizWinBadgeError('quiz_badge_in_use', {
        holderCount: Number(countRow.holder_count),
      });
    }
  }

  private async readDefinition(
    definitionId: string,
  ): Promise<QuizBadgeDefinitionDTO> {
    const rows = returnedRowsOf<DefinitionRow>(
      await this.dataSource.query(READ_QUIZ_BADGE_DEFINITION_SQL, [
        definitionId,
      ]),
    );
    const [definitionRow] = rows;
    if (!definitionRow) {
      throw quizWinBadgeError('quiz_badge_not_found', { definitionId });
    }
    return toDefinitionDto(definitionRow);
  }

  /** The `quiz_badge_name_taken` refusal of a unique violation, or null. */
  private refuseTakenName(error: unknown): Error | null {
    const language = uniqueViolationLanguage(error);
    return language === null
      ? null
      : quizWinBadgeError('quiz_badge_name_taken', { language });
  }

  /**
   * Checks the body field by field in the contract order (`name.en`,
   * `name.pt`, `description.en`, `description.pt`, `iconKey`, `tint`,
   * `rarity`); the first failure wins. On create a missing `name` or
   * `description` reads as `{}` and every field is required. On PATCH an
   * omitted object keeps the stored text and a given one replaces both
   * languages.
   */
  private normalizeFields(
    body: QuizBadgeDefinitionInputDto,
    isCreate: boolean,
  ): NormalizedDefinitionFields {
    const fields: NormalizedDefinitionFields = {};
    if (isCreate || body.name !== undefined) {
      const name = this.readTextObject(body.name, 'name');
      fields.nameEn = this.readNameEnglish(name);
      fields.namePt = this.readNamePortuguese(name);
    }
    if (isCreate || body.description !== undefined) {
      const description = this.readTextObject(body.description, 'description');
      fields.descriptionEn = this.readDescriptionEnglish(description);
      fields.descriptionPt = this.readDescriptionPortuguese(description);
    }
    if (isCreate || body.iconKey !== undefined) {
      fields.iconKey = this.readIconKey(body.iconKey);
    }
    if (isCreate || body.tint !== undefined) {
      fields.tint = this.readTint(body.tint);
    }
    if (isCreate || body.rarity !== undefined) {
      fields.rarity = this.readRarity(body.rarity);
    }
    return fields;
  }

  /** An absent `name` or `description` reads as `{}`; any other non-object
   *  answers `quiz_badge_text_invalid` for the English field. */
  private readTextObject(value: unknown, field: TextFieldName): TextObject {
    if (value === undefined) return {};
    if (!isPlainObject(value)) {
      throw quizWinBadgeError('quiz_badge_text_invalid', {
        field: field === 'name' ? 'name.en' : 'description.en',
      });
    }
    return value;
  }

  private readNameEnglish(name: TextObject): string {
    if (name.en !== undefined && typeof name.en !== 'string') {
      throw quizWinBadgeError('quiz_badge_text_invalid', { field: 'name.en' });
    }
    const stored = toStoredPlainTextOrNull(name.en)?.trim() ?? '';
    if (stored.length === 0) {
      throw quizWinBadgeError('quiz_badge_name_required', { language: 'en' });
    }
    if (codePointLength(stored) > QUIZ_BADGE_NAME_MAX_LENGTH) {
      throw quizWinBadgeError('quiz_badge_name_too_long', {
        language: 'en',
        maxLength: QUIZ_BADGE_NAME_MAX_LENGTH,
      });
    }
    return stored;
  }

  private readNamePortuguese(name: TextObject): string | null {
    if (name.pt === undefined || name.pt === null) return null;
    if (typeof name.pt !== 'string') {
      throw quizWinBadgeError('quiz_badge_text_invalid', { field: 'name.pt' });
    }
    const stored = toStoredPlainTextOrNull(name.pt)?.trim() ?? '';
    if (stored.length === 0) return null;
    if (codePointLength(stored) > QUIZ_BADGE_NAME_MAX_LENGTH) {
      throw quizWinBadgeError('quiz_badge_name_too_long', {
        language: 'pt',
        maxLength: QUIZ_BADGE_NAME_MAX_LENGTH,
      });
    }
    return stored;
  }

  private readDescriptionEnglish(description: TextObject): string {
    if (description.en !== undefined && typeof description.en !== 'string') {
      throw quizWinBadgeError('quiz_badge_text_invalid', {
        field: 'description.en',
      });
    }
    const stored = toStoredPlainTextOrNull(description.en)?.trim() ?? '';
    if (stored.length === 0) {
      throw quizWinBadgeError('quiz_badge_description_required', {
        language: 'en',
      });
    }
    if (codePointLength(stored) > QUIZ_BADGE_DESCRIPTION_MAX_LENGTH) {
      throw quizWinBadgeError('quiz_badge_description_too_long', {
        language: 'en',
        maxLength: QUIZ_BADGE_DESCRIPTION_MAX_LENGTH,
      });
    }
    return stored;
  }

  private readDescriptionPortuguese(description: TextObject): string | null {
    if (description.pt === undefined || description.pt === null) return null;
    if (typeof description.pt !== 'string') {
      throw quizWinBadgeError('quiz_badge_text_invalid', {
        field: 'description.pt',
      });
    }
    const stored = toStoredPlainTextOrNull(description.pt)?.trim() ?? '';
    if (stored.length === 0) return null;
    if (codePointLength(stored) > QUIZ_BADGE_DESCRIPTION_MAX_LENGTH) {
      throw quizWinBadgeError('quiz_badge_description_too_long', {
        language: 'pt',
        maxLength: QUIZ_BADGE_DESCRIPTION_MAX_LENGTH,
      });
    }
    return stored;
  }

  private readIconKey(value: unknown): CommunityBadgeIconKey {
    if (!isCommunityBadgeIconKey(value)) {
      throw quizWinBadgeError('quiz_badge_icon_unknown');
    }
    return value;
  }

  private readTint(value: unknown): BadgeTint {
    if (!(QUIZ_BADGE_TINTS as readonly unknown[]).includes(value)) {
      throw quizWinBadgeError('quiz_badge_tint_unknown');
    }
    return value as BadgeTint;
  }

  private readRarity(value: unknown): BadgeRarity {
    if (!(QUIZ_BADGE_RARITIES as readonly unknown[]).includes(value)) {
      throw quizWinBadgeError('quiz_badge_rarity_unknown');
    }
    return value as BadgeRarity;
  }

  /**
   * Answers `quiz_badge_name_taken` when the English name matches a code badge
   * or another definition (case ignored), or the Portuguese name matches
   * another definition. The unique indexes stay the last line of defence.
   */
  private async assertNamesAvailable(
    fields: NormalizedDefinitionFields,
    ownDefinitionId: string,
  ): Promise<void> {
    if (fields.nameEn !== undefined) {
      if (CODE_BADGE_NAMES_LOWERCASE.has(fields.nameEn.toLowerCase())) {
        throw quizWinBadgeError('quiz_badge_name_taken', { language: 'en' });
      }
      const englishRows = returnedRowsOf<{ found: number }>(
        await this.dataSource.query(ENGLISH_NAME_TAKEN_SQL, [
          fields.nameEn,
          ownDefinitionId,
        ]),
      );
      if (englishRows.length > 0) {
        throw quizWinBadgeError('quiz_badge_name_taken', { language: 'en' });
      }
    }
    if (fields.namePt !== undefined && fields.namePt !== null) {
      const portugueseRows = returnedRowsOf<{ found: number }>(
        await this.dataSource.query(PORTUGUESE_NAME_TAKEN_SQL, [
          fields.namePt,
          ownDefinitionId,
        ]),
      );
      if (portugueseRows.length > 0) {
        throw quizWinBadgeError('quiz_badge_name_taken', { language: 'pt' });
      }
    }
  }
}
