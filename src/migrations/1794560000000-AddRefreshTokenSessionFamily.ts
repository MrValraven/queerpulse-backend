import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Give `refresh_tokens` a stable SESSION identity that survives rotation.
 *
 * Until now a "session" on the security page was one refresh-token ROW, and
 * rotation replaces the row on every refresh. That made the row a credential
 * rather than a session, with two visible consequences:
 *
 *  - "Signed in 7 minutes ago" reset on every 15-minute rotation, so an
 *    honest answer to "when did this device sign in?" was never available.
 *  - The rotation-race grace path (`AuthService.issueGraceReplacement`) mints
 *    a brand-new row while the race winner's row stays live, so one browser
 *    ended up holding two rows and the page listed it as two devices.
 *
 * `family_id` groups every row descended from one sign-in, and
 * `session_started_at` carries that sign-in's timestamp forward through each
 * rotation. Both are backfilled from the row itself, so existing sessions
 * become single-row families dated at their own creation — accurate for what
 * we know, without inventing history we never recorded.
 *
 * The index mirrors `IDX_refresh_tokens_user_id`: every read is
 * "the live rows for this user grouped by family", and every family revoke is
 * "the live rows in this family".
 */
export class AddRefreshTokenSessionFamily1794560000000 implements MigrationInterface {
  name = 'AddRefreshTokenSessionFamily1794560000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD COLUMN "family_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD COLUMN "session_started_at" TIMESTAMP WITH TIME ZONE`,
    );
    // Backfill BEFORE the NOT NULL so the ALTER cannot fail on existing rows.
    // A pre-migration row is its own family, started when it was created.
    await queryRunner.query(
      `UPDATE "refresh_tokens" SET "family_id" = "id", "session_started_at" = "created_at" WHERE "family_id" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ALTER COLUMN "family_id" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ALTER COLUMN "session_started_at" SET NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_family_id" ON "refresh_tokens" ("family_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_refresh_tokens_family_id"`);
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN "session_started_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN "family_id"`,
    );
  }
}
