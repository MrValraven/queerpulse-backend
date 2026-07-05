import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Performance indexes and audit-FK integrity for hot query paths.
 *
 * Every index here backs a filter/sort that the services already run
 * (FK lookups, unread-notification counts, message-history pagination,
 * event listings). None of it changes application behaviour.
 *
 * The connections foreign keys (Section C) are a separate, clearly-commented
 * block because ADD CONSTRAINT ... FOREIGN KEY fails if any row references a
 * missing user. See the note in `up()` before running against data with
 * unknown provenance.
 */
export class AddPerformanceIndexes1782692700000 implements MigrationInterface {
  name = 'AddPerformanceIndexes1782692700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------------
    // Section A — indexes for FK lookups and common filters / sorts
    // ---------------------------------------------------------------------

    // refresh_tokens.user_id: revocation + "all sessions for a user" scans.
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_user_id" ON "refresh_tokens" ("user_id")`,
    );

    // group_memberships.group_id: "who is in this group" (the UNIQUE index on
    // (user_id, group_id) only helps when filtering by user_id first).
    await queryRunner.query(
      `CREATE INDEX "IDX_group_memberships_group_id" ON "group_memberships" ("group_id")`,
    );

    // events(status, start_at): published-events listing sorted by start time.
    await queryRunner.query(
      `CREATE INDEX "IDX_events_status_start_at" ON "events" ("status", "start_at")`,
    );

    // notifications(user_id, read): unread-count / unread-list queries.
    await queryRunner.query(
      `CREATE INDEX "IDX_notifications_user_id_read" ON "notifications" ("user_id", "read")`,
    );
    // notifications(user_id, created_at DESC): the notification timeline.
    await queryRunner.query(
      `CREATE INDEX "IDX_notifications_user_id_created_at" ON "notifications" ("user_id", "created_at" DESC)`,
    );

    // messages(conversation_id, created_at DESC): message-history pagination.
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_conversation_id_created_at" ON "messages" ("conversation_id", "created_at" DESC)`,
    );
    // messages.sender_id: FK lookup / "messages by sender" (indexes the FK).
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_sender_id" ON "messages" ("sender_id")`,
    );

    // ---------------------------------------------------------------------
    // Section B — index the existing audit foreign keys
    // ---------------------------------------------------------------------

    await queryRunner.query(
      `CREATE INDEX "IDX_invites_accepted_by" ON "invites" ("accepted_by")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_join_requests_reviewed_by" ON "join_requests" ("reviewed_by")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cinema_titles_created_by" ON "cinema_titles" ("created_by")`,
    );

    // ---------------------------------------------------------------------
    // Section C — connections referential integrity (REVIEW BEFORE APPLYING)
    //
    // connections.user_low / user_high / blocked_by currently have NO foreign
    // keys, so deleting a user leaves dangling ids in these columns. The FKs
    // below fix that (CASCADE for the pair columns, SET NULL for the auditor).
    //
    // CAVEAT: `ADD CONSTRAINT ... FOREIGN KEY` fails with a 23503 error if any
    // existing row references a user id that no longer exists. This is safe on
    // a fresh database (CI) and on any dataset created after connections'
    // requester_id/addressee_id CASCADE FKs were in place. If you are unsure
    // about orphan rows, first run and clean up:
    //   SELECT c.id FROM connections c
    //     LEFT JOIN users lo ON lo.id = c.user_low  WHERE lo.id IS NULL
    //   UNION SELECT c.id FROM connections c
    //     LEFT JOIN users hi ON hi.id = c.user_high WHERE hi.id IS NULL
    //   UNION SELECT c.id FROM connections c
    //     LEFT JOIN users bb ON bb.id = c.blocked_by
    //     WHERE c.blocked_by IS NOT NULL AND bb.id IS NULL;
    // then delete/repair those rows (or temporarily comment out this block).
    // ---------------------------------------------------------------------

    // Index the referencing columns so cascade deletes / lookups stay fast.
    // user_low is already covered by UQ_connections_pair (user_low, user_high)
    // as the leading column, so only user_high and blocked_by need one.
    await queryRunner.query(
      `CREATE INDEX "IDX_connections_user_high" ON "connections" ("user_high")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_connections_blocked_by" ON "connections" ("blocked_by")`,
    );

    await queryRunner.query(
      `ALTER TABLE "connections" ADD CONSTRAINT "FK_connections_user_low" FOREIGN KEY ("user_low") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "connections" ADD CONSTRAINT "FK_connections_user_high" FOREIGN KEY ("user_high") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "connections" ADD CONSTRAINT "FK_connections_blocked_by" FOREIGN KEY ("blocked_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Section C — reverse the connections FKs + their supporting indexes.
    await queryRunner.query(
      `ALTER TABLE "connections" DROP CONSTRAINT "FK_connections_blocked_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "connections" DROP CONSTRAINT "FK_connections_user_high"`,
    );
    await queryRunner.query(
      `ALTER TABLE "connections" DROP CONSTRAINT "FK_connections_user_low"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_connections_blocked_by"`);
    await queryRunner.query(`DROP INDEX "IDX_connections_user_high"`);

    // Section B — audit-FK indexes.
    await queryRunner.query(`DROP INDEX "IDX_cinema_titles_created_by"`);
    await queryRunner.query(`DROP INDEX "IDX_join_requests_reviewed_by"`);
    await queryRunner.query(`DROP INDEX "IDX_invites_accepted_by"`);

    // Section A — query-path indexes.
    await queryRunner.query(`DROP INDEX "IDX_messages_sender_id"`);
    await queryRunner.query(
      `DROP INDEX "IDX_messages_conversation_id_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_notifications_user_id_created_at"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_notifications_user_id_read"`);
    await queryRunner.query(`DROP INDEX "IDX_events_status_start_at"`);
    await queryRunner.query(`DROP INDEX "IDX_group_memberships_group_id"`);
    await queryRunner.query(`DROP INDEX "IDX_refresh_tokens_user_id"`);
  }
}
