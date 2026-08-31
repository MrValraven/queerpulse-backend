import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs the new @-mentions inbox (`MentionsInboxService.list`), the first read
 * path to filter `notifications` by `type` (= 'mention') and page by
 * `created_at DESC`. The `notifications` table indexes `(user_id, created_at)`,
 * `(user_id, read)`, and `user_id` — none include `type` — so the planner could
 * walk one user's rows in date order but still had to discard every non-mention
 * row (connection requests, messages, event invites, forum replies, …) to reach
 * the mention subset. That cost grows with a member's TOTAL notification volume,
 * not their mention count, and the inbox is a page they revisit often.
 *
 * This composite b-tree on `(user_id, type, created_at DESC)` lets the mention
 * query jump straight to that user's mention rows in the order the endpoint
 * returns them, serving the whole `user_id = ? AND type = 'mention' ORDER BY
 * created_at DESC LIMIT` as an ordered index scan.
 *
 * `notifications` carries production traffic, so the index builds
 * `CREATE INDEX CONCURRENTLY` — which cannot run inside a transaction block, so
 * the migration opts out (`transaction = false`, honored because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 */
export class AddNotificationsTypeIndex1786000900000 implements MigrationInterface {
  name = 'AddNotificationsTypeIndex1786000900000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_notifications_user_id_type_created_at" ` +
        `ON "notifications" ("user_id", "type", "created_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_notifications_user_id_type_created_at"`,
    );
  }
}
