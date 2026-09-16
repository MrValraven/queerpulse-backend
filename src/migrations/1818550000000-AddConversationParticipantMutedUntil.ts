import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One additive, nullable column on `conversation_participants` (PRD-349):
 *
 * `muted_until`: when a TIMED mute (8 hours / 1 week, chosen from the row or
 * conversation menu) expires. NULL means either "not muted" (when `muted` is
 * false) or "muted forever" (when `muted` is true and this is NULL, the
 * pre-PRD-349 shape, and the new "Always" choice); there is no separate
 * forever sentinel. See `ConversationParticipant.mutedUntil`'s own doc for the
 * lazy-clear contract once a timed mute's expiry has passed, and
 * `isParticipantMuted`/`notCurrentlyMutedPredicate` (same file) for the single
 * definition of "is this participant currently muted" every reader must use
 * instead of the bare `muted` column.
 *
 * Nullable with no default and no backfill: every existing row starts NULL,
 * the correct existing state for every conversation participant today (a
 * pre-PRD-349 `muted = true` row simply reads as "muted forever", unchanged
 * behaviour). A single plain `ADD COLUMN` against an existing table with no
 * new index; no `CONCURRENTLY` split needed.
 */
export class AddConversationParticipantMutedUntil1818550000000 implements MigrationInterface {
  name = 'AddConversationParticipantMutedUntil1818550000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        ADD COLUMN "muted_until" timestamptz NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        DROP COLUMN "muted_until"
    `);
  }
}
