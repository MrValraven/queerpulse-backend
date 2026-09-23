import { MigrationInterface, QueryRunner } from 'typeorm';

// DO NOT RUN: authored for review only; the maintainer runs migrations.
/**
 * Tightens `messages.sender_identity_id`, added nullable by `1821220000000`,
 * once its backfill has run: the index and the CHECK that a message with a
 * human sender also carries an identity. Its sibling
 * `1821230000000-SetConversationParticipantIdentityNotNull.ts` does the
 * equivalent work for `conversation_participants` inside an ordinary
 * transaction; this migration cannot follow it, for the reason below.
 *
 * Fix round 2 (Task 11): deliberately NOT a foreign key. An earlier version
 * of this migration added `FK_messages_sender_identity ON DELETE SET NULL`,
 * which meant a deleted listing, persona or company nulled `sender_identity_id`
 * on every message it ever sent, and each of those messages then fell
 * through to `senderAuthorSummary(m.senderId, ...)`: the staff member's own
 * profile, personal handle included, rendered as the sender of a customer's
 * entire history with a business that no longer exists. Leaving out the
 * foreign key mirrors `Message.erasedSenderRef`'s own reasoning exactly (see
 * its doc comment on the entity): the row this column names can go away, and
 * this column must survive that so a reader can still tell "sent as an
 * identity that no longer exists" apart from a genuinely personal message.
 * See `Message.senderIdentityId`'s own doc comment for the full reasoning
 * and `MessagingCoreService.toMessageResponses`'s former-business
 * placeholder, which is what actually closes the leak at render time.
 *
 * TRANSACTION. `messages` takes an insert on every send and this repo already
 * documents it as the platform's highest-write table (see
 * `1820530000000-KeepCounterpartMessagesOnSenderErasure.ts`). A plain
 * `CREATE INDEX` and an `ADD CONSTRAINT ... CHECK` each take an ACCESS
 * EXCLUSIVE lock on the table, and Postgres validates a CHECK against every
 * existing row at add time unless it is declared `NOT VALID`, holding that
 * lock for the whole scan. This migration therefore opts out of the
 * per-migration transaction (`migrationsTransactionMode: 'each'`, see
 * `data-source.ts`), the same way `1820530000000` does for the same table and
 * the same reason, which is what lets it build the index `CONCURRENTLY` and
 * add the CHECK as a brief `NOT VALID` add followed by a
 * `VALIDATE CONSTRAINT` that only takes a SHARE UPDATE EXCLUSIVE lock and
 * does not block reads or writes. The predicate itself is unchanged: a
 * message with a human sender also carries an identity, and the
 * erased-sender case where both are null stays legal. The cost is that the
 * steps commit one by one, so a failure part-way leaves the earlier ones
 * applied; see the paragraph below for what a part-way failure needs.
 * `down()` runs outside a transaction for the same reason, which is what
 * lets it use `DROP INDEX CONCURRENTLY`.
 *
 * That earlier version, before Fix round 2 rewrote it, shipped as the
 * combined `SetMessagingIdentityNotNull1821230000000` and added
 * `FK_messages_sender_identity`. Unguarded on purpose: the ledger records
 * that earlier file as never applied anywhere, so there is no database where
 * this index, that foreign key, or the CHECK below could already exist. An
 * `IF NOT EXISTS` or `IF EXISTS` guard would let a second run succeed
 * against a ledger the schema disagrees with, silently hiding the drift
 * that an unguarded run would surface immediately (see CLAUDE.md). Because
 * the foreign key was never created anywhere, `up()` no longer drops it
 * either; a fixed database would fail the same way a genuine
 * `DROP CONSTRAINT` on a missing constraint always does. If a specific
 * database turns out to have run the old combined file after all, diagnose
 * and repair its ledger row (`pnpm run typeorm migration:show`); re-adding a
 * guard here would only mask the mismatch. That repair is also what a
 * part-way failure of this migration itself needs before a re-run, now that
 * no step silently skips work already in place.
 */
export class SetMessagesSenderIdentityConstraints1821235000000 implements MigrationInterface {
  name = 'SetMessagesSenderIdentityConstraints1821235000000';

  // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. See the
  // TRANSACTION paragraph above for what that costs on a part-way failure.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_messages_sender_identity_id" ON "messages" ("sender_identity_id")`,
    );
    // No foreign key here, on purpose: see this file's own doc comment and
    // `Message.senderIdentityId`'s doc comment for the full reasoning. A
    // foreign key with `ON DELETE SET NULL` is exactly what a deleted
    // identity would use to erase this column, which is the leak this
    // change closes. `FK_messages_sender_identity` was never applied
    // anywhere (see the doc comment above), so there is nothing to drop here.
    await queryRunner.query(`
      ALTER TABLE "messages"
        ADD CONSTRAINT "CHK_messages_sender_identity" CHECK (
          "sender_id" IS NULL OR "sender_identity_id" IS NOT NULL
        )
        NOT VALID
    `);
    await queryRunner.query(
      `ALTER TABLE "messages" VALIDATE CONSTRAINT "CHK_messages_sender_identity"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT "CHK_messages_sender_identity"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_messages_sender_identity_id"`,
    );
  }
}
