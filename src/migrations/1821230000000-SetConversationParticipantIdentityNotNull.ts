import { MigrationInterface, QueryRunner } from 'typeorm';

// DO NOT RUN: authored for review only; the maintainer runs migrations.
/**
 * Tightens `conversation_participants.identity_id`, added nullable by
 * `1821220000000`, once its backfill has run: NOT NULL, the foreign key to
 * `identities`, and the index.
 *
 * TRANSACTION. This migration keeps the ordinary per-migration transaction,
 * unlike its sibling `1821235000000-SetMessagesSenderIdentityConstraints.ts`,
 * which opts out for `messages`. The two tables are not the same risk:
 * `conversation_participants` is orders of magnitude smaller than `messages`,
 * holding roughly one row per member per conversation rather than one row per
 * message ever sent, and it takes no insert on the hot send path the way
 * `messages` does. The maintainer also runs migrations by hand rather than
 * during a live deploy, so the brief ACCESS EXCLUSIVE lock this migration
 * takes on `conversation_participants` is accepted deliberately rather than
 * overlooked. Do not read the two migrations' different shapes as one of them
 * being a mistake; the same lock that is fine here is the reason
 * `1821235000000` avoids it on `messages`.
 *
 * This file and `1821235000000` are a split of an earlier combined
 * migration, `SetMessagingIdentityNotNull1821230000000`. Unguarded on
 * purpose: the ledger records that earlier file as never applied anywhere,
 * so there is no database where this one's constraint or index could already
 * exist. An `IF NOT EXISTS` guard would let a second run succeed against a
 * ledger the schema disagrees with, silently hiding the drift that an
 * unguarded run would surface immediately (see CLAUDE.md). If a specific
 * database turns out to have run the old combined file after all, diagnose
 * and repair its ledger row (`pnpm run typeorm migration:show`); re-adding a
 * guard here would only mask the mismatch.
 */
export class SetConversationParticipantIdentityNotNull1821230000000 implements MigrationInterface {
  name = 'SetConversationParticipantIdentityNotNull1821230000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversation_participants" ALTER COLUMN "identity_id" SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        ADD CONSTRAINT "FK_conversation_participants_identity"
        FOREIGN KEY ("identity_id") REFERENCES "identities"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_conversation_participants_identity_id"
        ON "conversation_participants" ("identity_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_conversation_participants_identity_id"`,
    );
    await queryRunner.query(`
      ALTER TABLE "conversation_participants" DROP CONSTRAINT "FK_conversation_participants_identity"
    `);
    await queryRunner.query(`
      ALTER TABLE "conversation_participants" ALTER COLUMN "identity_id" DROP NOT NULL
    `);
  }
}
