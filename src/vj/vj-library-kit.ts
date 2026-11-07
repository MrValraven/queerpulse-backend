import { HttpException, Logger } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { StorageService } from '../storage/storage.service';
import { isUuidText } from './vj-input';
import { vjError } from './vj.constants';
import type { VjLibraryChange, VjLibraryChangeKind } from './vj.contract';

/**
 * The helpers every VJ library service shares: one transaction runner that
 * maps named constraint violations to contract refusals, id parsing, the
 * library change builder, best effort object deletes, and the position
 * rewrites of the v2 ordered tables. Nothing here logs a title, a name or a
 * look: log lines carry storage keys only.
 */

/** Who runs a VJ library write: the admin whose id lands in
 *  `created_by_user_id`. */
export type VjCaller = Pick<CurrentUserData, 'userId'>;

/** The refusal each named constraint answers when a write trips it. */
export interface VjTransactionRefusals {
  onUnique?: ReadonlyMap<string, () => HttpException>;
  onForeignKey?: ReadonlyMap<string, () => HttpException>;
}

/** The not-found codes a malformed route or body id answers. */
export type VjIdRefusalCode =
  | 'VJ_PACK_NOT_FOUND'
  | 'VJ_CLIP_NOT_FOUND'
  | 'VJ_SCENE_NOT_FOUND'
  | 'VJ_SETLIST_NOT_FOUND';

const POSTGRES_UNIQUE_VIOLATION = '23505';
const POSTGRES_FOREIGN_KEY_VIOLATION = '23503';

/** Rewrites scene positions to `0..n-1` in `position, id` order, touching
 *  only rows whose position differs. Raw SQL, so `updated_at` stays. */
export const DENSIFY_VJ_SCENES_SQL = `UPDATE "vj_scenes" AS "scene" SET "position" = "ranked"."dense_position"
FROM (SELECT "id", (ROW_NUMBER() OVER (ORDER BY "position", "id") - 1)::int AS "dense_position" FROM "vj_scenes") AS "ranked"
WHERE "scene"."id" = "ranked"."id" AND "scene"."position" <> "ranked"."dense_position"`;

/** Rewrites set list positions to `0..n-1` in `position, id` order,
 *  touching only rows whose position differs. Raw SQL, so `updated_at`
 *  stays. */
export const DENSIFY_VJ_SETLISTS_SQL = `UPDATE "vj_setlists" AS "setlist" SET "position" = "ranked"."dense_position"
FROM (SELECT "id", (ROW_NUMBER() OVER (ORDER BY "position", "id") - 1)::int AS "dense_position" FROM "vj_setlists") AS "ranked"
WHERE "setlist"."id" = "ranked"."id" AND "setlist"."position" <> "ranked"."dense_position"`;

/** `$1` set list ids. Rewrites each listed set list's item positions to
 *  `0..n-1` in `position, id` order, touching only rows whose position
 *  differs. */
export const DENSIFY_VJ_SETLIST_ITEMS_SQL = `UPDATE "vj_setlist_items" AS "item" SET "position" = "ranked"."dense_position"
FROM (SELECT "id", (ROW_NUMBER() OVER (PARTITION BY "setlist_id" ORDER BY "position", "id") - 1)::int AS "dense_position" FROM "vj_setlist_items" WHERE "setlist_id" = ANY($1::uuid[])) AS "ranked"
WHERE "item"."id" = "ranked"."id" AND "item"."position" <> "ranked"."dense_position"`;

/** The constraint a Postgres error with `code` names, or null for any other
 *  error. */
function violatedConstraintOf(error: unknown, code: string): string | null {
  if (!(error instanceof QueryFailedError)) {
    return null;
  }
  const driverError = error.driverError as
    { code?: unknown; constraint?: unknown } | undefined;
  if (
    driverError?.code !== code ||
    typeof driverError.constraint !== 'string'
  ) {
    return null;
  }
  return driverError.constraint;
}

/** The constraint name of a unique violation, or null for any other error. */
export function violatedUniqueConstraintOf(error: unknown): string | null {
  return violatedConstraintOf(error, POSTGRES_UNIQUE_VIOLATION);
}

/** The constraint name of a foreign key violation, or null for any other
 *  error. */
export function violatedForeignKeyConstraintOf(error: unknown): string | null {
  return violatedConstraintOf(error, POSTGRES_FOREIGN_KEY_VIOLATION);
}

/** One transaction; a unique or foreign key violation named in the maps
 *  answers its refusal; anything else is rethrown unchanged. */
export async function runVjTransaction<Result>(
  dataSource: DataSource,
  work: (manager: EntityManager) => Promise<Result>,
  refusals: VjTransactionRefusals,
): Promise<Result> {
  try {
    return await dataSource.transaction(work);
  } catch (error) {
    const uniqueConstraint = violatedUniqueConstraintOf(error);
    const uniqueRefusal =
      uniqueConstraint === null
        ? undefined
        : refusals.onUnique?.get(uniqueConstraint);
    if (uniqueRefusal) {
      throw uniqueRefusal();
    }
    const foreignKeyConstraint = violatedForeignKeyConstraintOf(error);
    const foreignKeyRefusal =
      foreignKeyConstraint === null
        ? undefined
        : refusals.onForeignKey?.get(foreignKeyConstraint);
    if (foreignKeyRefusal) {
      throw foreignKeyRefusal();
    }
    throw error;
  }
}

/** A route or body id lowercased, the form Postgres answers and the `/vj`
 *  gateway compares against; anything but a uuid answers `code`. */
export function lowercaseIdOrRefuse(
  value: unknown,
  code: VjIdRefusalCode,
): string {
  if (!isUuidText(value)) {
    throw vjError(code);
  }
  return value.toLowerCase();
}

/** Fills every VjLibraryChange field the write leaves unset with null or
 *  []. Lists are copied, so a later edit of the caller's array never reaches
 *  the emitted change. */
export function buildVjLibraryChange(
  kind: VjLibraryChangeKind,
  fields: Partial<Omit<VjLibraryChange, 'kind'>>,
): VjLibraryChange {
  return {
    kind,
    packId: fields.packId ?? null,
    clipId: fields.clipId ?? null,
    packIds: [...(fields.packIds ?? [])],
    sceneId: fields.sceneId ?? null,
    setlistId: fields.setlistId ?? null,
    setlistIds: [...(fields.setlistIds ?? [])],
    eventId: fields.eventId ?? null,
  };
}

/** A Date from a driver timestamp, which arrives as a Date or as text. */
export function asVjDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Deletes a stored object, best effort; a failure logs the key only and
 *  leaves the object to the orphan sweep. A null key deletes nothing. */
export async function deleteVjStoredObject(
  storage: StorageService,
  logger: Logger,
  key: string | null,
): Promise<void> {
  if (key === null) {
    return;
  }
  try {
    await storage.deleteObjectByKey(key);
  } catch {
    logger.warn(`VJ object delete failed: ${key}`);
  }
}
