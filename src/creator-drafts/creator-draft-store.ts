import { EntityManager, MoreThanOrEqual } from 'typeorm';
import type { StoredCreatorDraftKind } from './creator-drafts.constants';
import type { CreatorDraftProgress } from './creator-draft.types';
import { CreatorDraft } from './entities/creator-draft.entity';

/** One author's slot: the unique key a save lands on. */
export interface CreatorDraftSlot {
  userId: string;
  kind: StoredCreatorDraftKind;
  slotKey: string;
}

/** What one save writes. `baseRevision` is the revision the caller read, or
 *  null when the caller expects an empty (or expired) slot. */
export interface CreatorDraftWrite {
  payload: Record<string, unknown>;
  payloadVersion: number;
  baseRevision: number | null;
  progress: CreatorDraftProgress | null;
  missing: string[] | null;
  madeForCommunityId: string | null;
  madeForListingId: string | null;
}

/** `current` is the live row the save lost to, or null when the slot holds
 *  no live row. */
export type CreatorDraftSaveOutcome =
  | { isSaved: true; revision: number; savedAt: Date }
  | { isSaved: false; current: { revision: number; savedAt: Date } | null };

/** Raw row from the save's RETURNING clause (snake_case database columns). */
interface SavedDraftRow {
  revision: number;
  updated_at: Date;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * `$1..$10` slot and values, `$11` the expiry cutoff. Inserts into an empty
 * slot, or replaces a row last saved before the cutoff and starts it again at
 * revision 1 under a new id, so an earlier audit note naming the expired
 * draft's id never points at the new one (the same `uuid_generate_v4()` the
 * migration's column default uses). A live row in the slot makes the conflict
 * WHERE false, so the statement writes nothing and returns no row.
 */
export const INSERT_CREATOR_DRAFT_SQL = `INSERT INTO "creator_drafts" ("user_id", "kind", "slot_key", "payload", "payload_version",
  "made_for_community_id", "made_for_listing_id", "progress_done", "progress_total", "missing")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT ("user_id", "kind", "slot_key") DO UPDATE SET
  "id" = uuid_generate_v4(), "payload" = EXCLUDED."payload", "payload_version" = EXCLUDED."payload_version", "revision" = 1,
  "made_for_community_id" = EXCLUDED."made_for_community_id", "made_for_listing_id" = EXCLUDED."made_for_listing_id",
  "progress_done" = EXCLUDED."progress_done", "progress_total" = EXCLUDED."progress_total",
  "missing" = EXCLUDED."missing", "created_at" = now(), "updated_at" = now()
  WHERE "creator_drafts"."updated_at" < $11
RETURNING "revision", "updated_at"`;

/**
 * `$1..$10` slot and values, `$11` the base revision, `$12` the expiry
 * cutoff. Lands only on the live row still at the base revision.
 */
export const UPDATE_CREATOR_DRAFT_SQL = `UPDATE "creator_drafts" SET "payload" = $4, "payload_version" = $5, "revision" = "revision" + 1,
  "made_for_community_id" = $6, "made_for_listing_id" = $7, "progress_done" = $8, "progress_total" = $9,
  "missing" = $10, "updated_at" = now()
WHERE "user_id" = $1 AND "kind" = $2 AND "slot_key" = $3 AND "revision" = $11 AND "updated_at" >= $12
RETURNING "revision", "updated_at"`;

/** A row saved before this instant is expired: absent to every read and
 *  replaceable by a save with a null base revision. */
export function creatorDraftExpiryCutoff(
  now: Date,
  retentionDays: number,
): Date {
  return new Date(now.getTime() - retentionDays * MILLISECONDS_PER_DAY);
}

/**
 * Saves one draft with a single conditional statement, so two tabs saving
 * on the same base can never both win: Postgres re-checks the revision on
 * the locked row, and the loser's statement matches nothing. On a mismatch
 * this writes nothing and reports the live row (null when the slot is empty
 * or expired) for the 409.
 */
export async function saveCreatorDraftWithin(
  manager: EntityManager,
  slot: CreatorDraftSlot,
  write: CreatorDraftWrite,
  expiryCutoff: Date,
): Promise<CreatorDraftSaveOutcome> {
  const values: unknown[] = [
    slot.userId,
    slot.kind,
    slot.slotKey,
    write.payload,
    write.payloadVersion,
    write.madeForCommunityId,
    write.madeForListingId,
    write.progress?.done ?? null,
    write.progress?.total ?? null,
    write.missing,
  ];
  const savedRow =
    write.baseRevision === null
      ? await insertIntoEmptySlot(manager, values, expiryCutoff)
      : await updateAtBaseRevision(
          manager,
          values,
          write.baseRevision,
          expiryCutoff,
        );
  if (savedRow) {
    return {
      isSaved: true,
      revision: savedRow.revision,
      savedAt: savedRow.updated_at,
    };
  }
  const liveDraft = await readCreatorDraftWithin(manager, slot, expiryCutoff);
  return {
    isSaved: false,
    current: liveDraft
      ? { revision: liveDraft.revision, savedAt: liveDraft.updatedAt }
      : null,
  };
}

/** An INSERT ... RETURNING answers its rows as a plain array. */
async function insertIntoEmptySlot(
  manager: EntityManager,
  values: unknown[],
  expiryCutoff: Date,
): Promise<SavedDraftRow | undefined> {
  const rows: SavedDraftRow[] = await manager.query(INSERT_CREATOR_DRAFT_SQL, [
    ...values,
    expiryCutoff,
  ]);
  return rows[0];
}

/** TypeORM answers an UPDATE ... RETURNING as `[rows, affectedCount]`. */
async function updateAtBaseRevision(
  manager: EntityManager,
  values: unknown[],
  baseRevision: number,
  expiryCutoff: Date,
): Promise<SavedDraftRow | undefined> {
  const [rows]: [SavedDraftRow[], number] = await manager.query(
    UPDATE_CREATOR_DRAFT_SQL,
    [...values, baseRevision, expiryCutoff],
  );
  return rows[0];
}

/** The live draft in the slot, or null when it is empty or expired. */
export async function readCreatorDraftWithin(
  manager: EntityManager,
  slot: CreatorDraftSlot,
  expiryCutoff: Date,
): Promise<CreatorDraft | null> {
  return manager.getRepository(CreatorDraft).findOne({
    where: {
      userId: slot.userId,
      kind: slot.kind,
      slotKey: slot.slotKey,
      updatedAt: MoreThanOrEqual(expiryCutoff),
    },
  });
}

/** Empties the slot. Deleting an empty slot is a no-op. */
export async function deleteCreatorDraftWithin(
  manager: EntityManager,
  slot: CreatorDraftSlot,
): Promise<void> {
  await manager.getRepository(CreatorDraft).delete({
    userId: slot.userId,
    kind: slot.kind,
    slotKey: slot.slotKey,
  });
}
