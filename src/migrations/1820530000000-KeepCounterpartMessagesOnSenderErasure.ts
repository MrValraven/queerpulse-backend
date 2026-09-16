// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-243: erasing an account no longer wipes the other side of every
 * conversation the member was part of.
 *
 * WHY. `messages.sender_id` has been `ON DELETE CASCADE` since
 * `AddMessaging1782691800000`, so hard-deleting a `users` row in
 * `AccountDeletionProcessorService.eraseAccount` silently removed every
 * message that member ever sent from every DM and group. Two things went wrong
 * at once: a counterpart's thread lost half its lines with no trace of them
 * ever existing, and a member being reported could erase their account and take
 * the victim's copy of the conversation with them. The product decision (ENG-243)
 * is "keep if open report, everything else shows up as 'message deleted'":
 *
 *  (a) in a conversation holding an OPEN or ESCALATED report tied to the
 *      member, their messages stay readable to the counterparts, with the
 *      sender anonymised;
 *  (b) every other message they sent becomes an ordinary tombstone
 *      ("Message deleted"), body blanked, so nothing disappears silently;
 *  (c) once no open or escalated tied report remains, a daily sweep turns the
 *      held messages from (a) into tombstones like (b).
 *
 * The erasure service does (a) and (b) inside its transaction BEFORE the user
 * row is deleted; `ErasedSenderMessageReleaseService` does (c). This migration
 * gives both of them a schema that lets the rows survive the delete.
 *
 * `messages.sender_id` -> NULLABLE, FK recreated as ON DELETE SET NULL. The row
 * survives the user delete with a NULL byline, exactly the call
 * `SetNullContentAuthorFksOnUserErasure1794610000000` made for content other
 * members depend on. A counterpart's thread is that kind of content: the message
 * slot belongs to the conversation as much as to its author. The privacy half
 * of erasure is carried by the tombstone (body blanked, attachment queued for
 * purge) rather than by deleting the slot. The magazine desk migration
 * `AddMagazineDeskAuthorForeignKeys1795810000000` cited this column's CASCADE as
 * precedent for `magazine_piece_message.author_id`; that desk thread is left as
 * it is, because its readers are an assigned editor and writer rather than the
 * person the member was talking to.
 *
 * `messages.erased_sender_ref uuid NULL` (no FK, by design). The former user id,
 * written ONLY on held rows from (a) and cleared by the release sweep. It is the
 * one piece of state the sweep needs to re-evaluate "is a tied report still
 * open?" after `sender_id` has gone NULL, and it points at a `users` row that no
 * longer exists, so a foreign key would reject every write of it. A partial
 * index on `(erased_sender_ref, conversation_id) WHERE erased_sender_ref IS NOT
 * NULL` keeps the sweep off a full scan while indexing nothing on the common
 * row.
 *
 * THE OTHER MESSAGING COLUMNS THAT REFERENCE `users`, DECIDED ONE BY ONE.
 *
 *  - `conversation_pinned_messages.pinned_by` -> SET NULL (was CASCADE, NOT
 *    NULL dropped). A pin is shared state in a conversation everyone in it
 *    sees. Cascading meant a group admin erasing their account unpinned the
 *    house rules for every other member. The only reader of the column is the
 *    insert in `MessageAnnotationsService.pinMessage`, so a NULL costs no read
 *    path. Already indexed (`IDX_conversation_pinned_messages_pinned_by`,
 *    `AddContentSocialErasureForeignKeyIndexes1796320000000`).
 *  - System pills ("Ana added Bea") are `messages` rows whose `sender_id` is the
 *    event's actor, so they ride the SET NULL above. They are audit lines, not
 *    something the member wrote, so erasure neither holds nor tombstones them;
 *    the actor and target ids live in the `system_event` jsonb, which has no FK
 *    and already resolves an unknown id to a neutral name at read time.
 *  - Forwards carry no user reference: `messages.forwarded` is a boolean and a
 *    forward is an ordinary message by the forwarder, covered by the rule above.
 *  - `message_reactions.user_id`, `message_stars.user_id`,
 *    `message_hides.user_id` -> CASCADE, unchanged. Each is the erased member's
 *    own private annotation (a reaction count drops by one, a star or a
 *    "delete for me" nobody else ever saw goes with them).
 *  - `conversation_participants.user_id` -> CASCADE, unchanged. The row is the
 *    member's own read watermark, mute, archive and draft. The counterpart's
 *    thread keeps working without it, and a group's roster simply loses them,
 *    as it would if they had left.
 *  - `conversation_participants.removed_by`, `conversations.created_by`,
 *    `conversations.initiator_user_id`, `group_invites.inviter_id` -> SET NULL
 *    already. `group_invites.invitee_id` -> CASCADE already (a pending invite
 *    for somebody who no longer exists has nobody to answer it).
 *
 * NO ORPHAN REPAIR. Both constraints being replaced were valid CASCADE foreign
 * keys, so no existing row points at a missing user and re-adding the
 * constraint validates cleanly.
 *
 * `messages (sender_id, id)`. The erasure's tombstone loop pages the member's
 * own messages with `WHERE sender_id = $1 AND ... AND id > $cursor ORDER BY id
 * LIMIT 1000`, inside the erasure transaction. The only candidate index was
 * `IDX_messages_sender_id` (`sender_id` alone), which answers the equality but
 * not the ordering, so every page re-read the member's entire history and
 * sorted it to find the next thousand ids. The composite index makes each page
 * an index range scan that stops after its limit, so a member with a long
 * history no longer holds the transaction open across repeated full sorts of
 * the platform's highest-write table.
 *
 * TRANSACTION. `messages` takes an insert on every send, so that index is built
 * `CONCURRENTLY`, which Postgres refuses inside a transaction block. This
 * migration therefore opts out of the per-migration transaction
 * (`migrationsTransactionMode: 'each'`, see `data-source.ts`), the same way
 * `1820510000000-AddMessageAttachmentPurgeAfter.ts` and
 * `1785003000000-AddReportsOpenDedupeIndex.ts` do. Every other statement here
 * is plain `ALTER TABLE` DDL that is valid outside a transaction; the cost is
 * that the steps commit one by one, so a failure part-way leaves the earlier
 * ones applied. Diagnose such a failure with `pnpm run typeorm migration:show`
 * and finish or reverse the remaining steps by hand rather than re-running,
 * which would fail on the constraint it already recreated. `down()` runs
 * outside a transaction for the same reason, which is what lets it use
 * `DROP INDEX CONCURRENTLY`.
 *
 * `down()` restores CASCADE and NOT NULL. It has to delete every message and pin
 * whose author was erased while this migration was in force first, because a
 * NOT NULL column cannot hold them. That is the behaviour being reverted to, and
 * it is destructive by nature.
 */
export class KeepCounterpartMessagesOnSenderErasure1820530000000 implements MigrationInterface {
  name = 'KeepCounterpartMessagesOnSenderErasure1820530000000';

  // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. See the
  // TRANSACTION paragraph above for what that costs on a part-way failure.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- messages.sender_id -> nullable, ON DELETE SET NULL ------------------
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT "FK_messages_sender_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ALTER COLUMN "sender_id" DROP NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "messages" ADD CONSTRAINT "FK_messages_sender_id"
        FOREIGN KEY ("sender_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // --- messages.erased_sender_ref ------------------------------------------
    await queryRunner.query(
      `ALTER TABLE "messages" ADD "erased_sender_ref" uuid`,
    );
    await queryRunner.query(`
      CREATE INDEX "IDX_messages_erased_sender_ref"
        ON "messages" ("erased_sender_ref", "conversation_id")
        WHERE "erased_sender_ref" IS NOT NULL
    `);

    // --- messages (sender_id, id) --------------------------------------------
    // Backs the erasure's keyset tombstone loop. See the paragraph above.
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_messages_sender_id_id" ON "messages" ("sender_id", "id")`,
    );

    // --- conversation_pinned_messages.pinned_by -> nullable, SET NULL --------
    await queryRunner.query(
      `ALTER TABLE "conversation_pinned_messages" DROP CONSTRAINT "FK_conversation_pinned_messages_pinned_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_pinned_messages" ALTER COLUMN "pinned_by" DROP NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "conversation_pinned_messages"
        ADD CONSTRAINT "FK_conversation_pinned_messages_pinned_by"
        FOREIGN KEY ("pinned_by") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_pinned_messages" DROP CONSTRAINT "FK_conversation_pinned_messages_pinned_by"`,
    );
    await queryRunner.query(
      `DELETE FROM "conversation_pinned_messages" WHERE "pinned_by" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_pinned_messages" ALTER COLUMN "pinned_by" SET NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "conversation_pinned_messages"
        ADD CONSTRAINT "FK_conversation_pinned_messages_pinned_by"
        FOREIGN KEY ("pinned_by") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_messages_sender_id_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_messages_erased_sender_ref"`);
    await queryRunner.query(
      `ALTER TABLE "messages" DROP COLUMN "erased_sender_ref"`,
    );

    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT "FK_messages_sender_id"`,
    );
    await queryRunner.query(`DELETE FROM "messages" WHERE "sender_id" IS NULL`);
    await queryRunner.query(
      `ALTER TABLE "messages" ALTER COLUMN "sender_id" SET NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "messages" ADD CONSTRAINT "FK_messages_sender_id"
        FOREIGN KEY ("sender_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }
}
