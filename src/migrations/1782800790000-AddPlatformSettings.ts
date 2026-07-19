import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Runtime platform kill switches — the first settings-in-database mechanism in
 * this codebase. Feature gating until now was compile-time only
 * (`src/launchedFeatures.ts`), which cannot help during a spam attack: the
 * response time is however long a deploy takes.
 *
 * Two tables:
 *
 * 1. **`platform_settings`** — a singleton row, enforced by `CHECK (id = 1)`
 *    rather than by convention. The row is INSERTed here so no application
 *    code has a missing-row branch to get wrong.
 *
 * 2. **`platform_setting_changes`** — one immutable row per changed field.
 *    `actor_id` is `ON DELETE SET NULL` for the same reason `mod_audit_logs`
 *    is (`AddDeletionErasureSupport1782800700000`): the erasure sweep
 *    hard-deletes the `users` row and relies on FK behaviour, and an action
 *    trail that disappears with its author is not a trail. `SET NULL`, not
 *    `CASCADE` — this is evidence about what happened to the platform, not
 *    personal data about the admin.
 *
 * Every default is the current behaviour (registration open, join requests
 * open, no lockdown), so applying this migration changes nothing until an
 * admin flips a switch.
 */
export class AddPlatformSettings1782800790000 implements MigrationInterface {
  name = 'AddPlatformSettings1782800790000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "platform_settings" (
        "id" integer NOT NULL,
        "registration_enabled" boolean NOT NULL DEFAULT true,
        "join_requests_enabled" boolean NOT NULL DEFAULT true,
        "lockdown_enabled" boolean NOT NULL DEFAULT false,
        "lockdown_allows_moderators" boolean NOT NULL DEFAULT false,
        "lockdown_message" text,
        "registration_closed_message" text,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by" uuid,
        CONSTRAINT "PK_platform_settings" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_platform_settings_singleton" CHECK ("id" = 1)
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "platform_settings" ADD CONSTRAINT "FK_platform_settings_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    // The singleton. Every column takes its default, i.e. today's behaviour.
    await queryRunner.query(
      `INSERT INTO "platform_settings" ("id") VALUES (1)`,
    );

    await queryRunner.query(`
      CREATE TABLE "platform_setting_changes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "actor_id" uuid,
        "setting_key" character varying NOT NULL,
        "old_value" text,
        "new_value" text,
        "note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_platform_setting_changes" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_platform_setting_changes_actor_id" ON "platform_setting_changes" ("actor_id")`,
    );
    // Backs the history list, which is always ordered newest-first.
    await queryRunner.query(
      `CREATE INDEX "IDX_platform_setting_changes_created_at" ON "platform_setting_changes" ("created_at")`,
    );

    await queryRunner.query(
      `ALTER TABLE "platform_setting_changes" ADD CONSTRAINT "FK_platform_setting_changes_actor_id" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "platform_setting_changes" DROP CONSTRAINT "FK_platform_setting_changes_actor_id"`,
    );
    await queryRunner.query(`DROP TABLE "platform_setting_changes"`);
    await queryRunner.query(
      `ALTER TABLE "platform_settings" DROP CONSTRAINT "FK_platform_settings_updated_by"`,
    );
    await queryRunner.query(`DROP TABLE "platform_settings"`);
  }
}
