import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Repair migration for a partially applied `AddGroupConsentInvitesAndDissolve`
 * (`1819000000000`).
 *
 * That migration's final shape adds `conversation_participants.removed_at`,
 * and on at least one database it ran while the file was at an earlier
 * revision, before that statement was appended. The result is a database that
 * has every other artefact of `1819000000000` (`conversations.description`,
 * `conversations.invite_token`, `conversations.dissolved_at`, the
 * `group_invites` table, `FK_conversation_participants_removed_by`) while
 * `removed_at` is missing, with the ledger row for `1819000000000` already
 * written. `migration:show` therefore reports nothing pending,
 * `migration:run` will never replay that file, and
 * `ConversationsService.listConversations` 500s on every call with
 * `column participant.removed_at does not exist`. Only a NEW migration with a
 * NEW timestamp can carry the column forward.
 *
 * `IF NOT EXISTS` is load-bearing here, and it is the one case this directory's
 * standing guidance against it does not cover. Every environment where
 * `1819000000000` ran against the complete file already has the column in
 * exactly the right shape, so for those this migration has to be a silent
 * no-op that still writes its ledger row and keeps the sequence linear. There
 * is no schema drift for the guard to hide: the column's full definition is a
 * bare nullable `TIMESTAMP WITH TIME ZONE` with no default, no constraint and
 * no FK, so "the column exists" and "the column is correct" are the same
 * statement.
 *
 * Two repairs were considered and rejected. Appending the column to
 * `1819000000000` is what already happened and is precisely why the drift is
 * stuck: its ledger row freezes it out of every future run. Hand-running the
 * `ALTER TABLE` against the affected database fixes one machine and leaves the
 * history lying about what the schema contains, so the next clone or restore
 * reproduces the outage. `1819000000000` itself stays untouched: its statement
 * remains correct for a fresh database, where it lands the column first and
 * this migration then finds it already there.
 *
 * Column semantics (see `ConversationParticipant.removedAt` for the full
 * reasoning): nullable timestamptz, the durable FK-free companion to
 * `removed_by`. It is stamped when a member is REMOVED and stays NULL on a
 * voluntary leave, and carrying no FK means the remover's own account being
 * deleted later can never null it back out. `computeGroupLeftReason` and
 * `joinByToken`'s REMOVED_FROM_GROUP gate both read this column's mere
 * presence to tell a removal from a leave, which is why its absence takes the
 * whole conversations list down on every read.
 */
export class AddConversationParticipantRemovedAt1820900000000 implements MigrationInterface {
  name = 'AddConversationParticipantRemovedAt1820900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        ADD COLUMN IF NOT EXISTS "removed_at" TIMESTAMP WITH TIME ZONE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        DROP COLUMN IF EXISTS "removed_at"
    `);
  }
}
