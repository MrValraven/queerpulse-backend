import { MigrationInterface, QueryRunner } from 'typeorm';

// `board_posts` already has `created_at` (see
// AddCreatedAtToRowAccretingTables1785004500000) — this migration only adds
// the closed/found lifecycle: a status enum, an optional closed note/
// timestamp, and an expiry. The 90-day column default only backfills
// existing rows at migration time; application code computes the real
// kind-dependent expiry (looking=+30d, offering=+90d) for every row it
// inserts going forward.
export class AddBoardPostLifecycleFields1791200100000 implements MigrationInterface {
  name = 'AddBoardPostLifecycleFields1791200100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "board_posts_status_enum" AS ENUM ('open', 'closed')
    `);
    await queryRunner.query(`
      ALTER TABLE "board_posts"
        ADD COLUMN "status" "board_posts_status_enum" NOT NULL DEFAULT 'open',
        ADD COLUMN "closed_note" text NULL,
        ADD COLUMN "closed_at" timestamptz NULL,
        ADD COLUMN "expires_at" timestamptz NOT NULL DEFAULT (now() + interval '90 days')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "board_posts"
        DROP COLUMN "status",
        DROP COLUMN "closed_note",
        DROP COLUMN "closed_at",
        DROP COLUMN "expires_at"
    `);
    await queryRunner.query(`DROP TYPE "board_posts_status_enum"`);
  }
}
