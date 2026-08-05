// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records WHO verified a member and WHEN, backing the admin member-moderation
 * "Verify" action (`POST /admin/members/:id/verify`).
 *
 * `profiles.verified` (boolean) already existed — it drives the verified badge
 * across the platform. This adds the accountability trail the boolean lacked:
 *
 *  - `verified_at`  — the moment an admin verified the member (NULL until then,
 *    and NULL for the legacy rows that were flipped `verified = true` before
 *    this column existed; deliberately NOT backfilled, because a manufactured
 *    timestamp would be a lie about when an act happened — same reasoning as
 *    `guidelines_accepted_at`).
 *  - `verified_by` — the admin's `users.id`. `ON DELETE SET NULL` so the record
 *    outlives the admin's account (mirrors `mod_audit_logs.actor_id` and
 *    `reports.reporter_id`, which are NULLed rather than cascaded on erasure so
 *    the trail survives the person who wrote it).
 *
 * The "Restrict" action reuses the existing suspension model
 * (`users.status = 'suspended'` + `users.suspended_until`) and the immutable
 * `mod_audit_logs` trail — it needs NO new columns, so none are added here.
 */
export class AddMemberModerationFields1786000400000
  implements MigrationInterface
{
  name = 'AddMemberModerationFields1786000400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "profiles"
      ADD "verified_at" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      ALTER TABLE "profiles"
      ADD "verified_by" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "profiles"
      ADD CONSTRAINT "FK_profiles_verified_by"
      FOREIGN KEY ("verified_by") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "profiles" DROP CONSTRAINT "FK_profiles_verified_by"
    `);
    await queryRunner.query(`
      ALTER TABLE "profiles" DROP COLUMN "verified_by"
    `);
    await queryRunner.query(`
      ALTER TABLE "profiles" DROP COLUMN "verified_at"
    `);
  }
}
