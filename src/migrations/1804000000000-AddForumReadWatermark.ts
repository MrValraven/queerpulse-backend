// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * C7 / PRD-170 — the forum's read watermark, on the table that already knows
 * who cares about which thread.
 *
 * THE GAP. The forum had no unread marker of any kind: no watermark, no
 * per-thread badge, no highlight of replies added since a member last opened a
 * thread. Someone following five threads got notifications, but on the list
 * itself could not see which threads had actually moved, so catching up meant
 * reopening each one and scrolling for something they might already have read.
 *
 * TWO COLUMNS, ONE ROW.
 *
 * `last_read_at` is the watermark: when this member last opened this thread.
 * NULL is "never opened", which stays distinguishable from "opened and nothing
 * new since" — the first renders as no badge at all, the second as a badge
 * showing zero, and a single column could not say both.
 *
 * `is_following` is the fact the row USED to carry by merely existing. It has
 * to become explicit because the watermark writes rows too: a member who opens
 * a thread now gets a row, and if existence still meant "following" then
 * reading a thread would have silently subscribed them to a notification for
 * every reply to it for the rest of its life. That is precisely the thing this
 * feature must not do, so `ForumSubscriptionsService.markRead` writes
 * `is_following = false` on insert and never touches the flag again.
 *
 * `DEFAULT true` is the backfill, and it is exactly right for the existing
 * rows: every one of them was written by a follow (thread creation, a reply, or
 * the Follow toggle), because until now there was no other way for a row to
 * exist. NOT NULL with that default, so no read has to consider a third state.
 *
 * The default stays on the column afterwards rather than being dropped: it
 * matches the dominant caller (`subscribe`) and leaves `markRead` to say
 * `false` explicitly, which reads as the deliberate exception it is.
 *
 * No index. Both columns are read through the composite primary key
 * `(thread_id, user_id)` or through `IDX_forum_thread_subscription_user_id` —
 * `unreadReplyCountsByThread` seeks `user_id = :viewer AND thread_id = ANY(...)`,
 * which the primary key serves, and `is_following` is a low-cardinality flag
 * that would not narrow anything the key has not already narrowed.
 */
export class AddForumReadWatermark1804000000000 implements MigrationInterface {
  name = 'AddForumReadWatermark1804000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_thread_subscription" ` +
        `ADD COLUMN "is_following" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_thread_subscription" ` +
        `ADD COLUMN "last_read_at" timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_thread_subscription" DROP COLUMN "last_read_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_thread_subscription" DROP COLUMN "is_following"`,
    );
  }
}
