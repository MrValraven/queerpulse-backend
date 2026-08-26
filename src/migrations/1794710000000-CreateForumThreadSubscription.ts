// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `forum_thread_subscription`: who is following a forum thread (SOC-13).
 *
 * Before this there was no way to hear about a thread you did not start. The
 * only "you got a reply" signals were `forum_thread_reply` (the thread author,
 * top-level replies only) and `forum_reply` (the parent post's author), so a
 * question you asked and then navigated away from dropped out of your life,
 * and a thread you were reading but had not posted in could never reach you.
 *
 * COMPOSITE PRIMARY KEY `(thread_id, user_id)` rather than a surrogate uuid:
 * following is idempotent by nature ("am I following this thread" is a yes/no,
 * never a list), so the key IS the identity and a repeat follow is an
 * `ON CONFLICT DO NOTHING` insert instead of a read-then-write race. Same shape
 * as `draft`'s `(id, user_id)` key.
 *
 * Both foreign keys CASCADE. A deleted thread's follow rows are meaningless,
 * and an erased account must not leave its follows behind (they would keep
 * receiving nothing forever while still counting toward the fan-out cap).
 * That is the opposite posture from `removed_account_signals`, deliberately:
 * this table is a live preference, not a record of something that happened.
 *
 * `IDX_forum_thread_subscription_user_id` backs the reverse read ("which
 * threads does this member follow"), which the batched list mapper uses as
 * `user_id = :viewer AND thread_id IN (...)`; the primary key covers the
 * forward read (a thread's subscriber fan-out).
 *
 * No `CREATE INDEX CONCURRENTLY`: the table is created empty in this same
 * migration, so every index builds on nothing and the file stays transactional.
 */
export class CreateForumThreadSubscription1794710000000 implements MigrationInterface {
  name = 'CreateForumThreadSubscription1794710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "forum_thread_subscription" (
        "thread_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_forum_thread_subscription" PRIMARY KEY ("thread_id", "user_id"),
        CONSTRAINT "FK_forum_thread_subscription_thread" FOREIGN KEY ("thread_id")
          REFERENCES "forum_thread"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_forum_thread_subscription_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_forum_thread_subscription_user_id"
        ON "forum_thread_subscription" ("user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "forum_thread_subscription"`);
  }
}
