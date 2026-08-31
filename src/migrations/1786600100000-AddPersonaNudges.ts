import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `persona_nudges` — the shared dismissal store backing the six persona
 * discovery "nudge" moments (Personas Phase 5 Task 1, see
 * `docs/superpowers/plans/2026-08-10-personas-phase5-discovery.md` Decision
 * §1): a nudge fires at most once and the whole set caps at 2 dismissals,
 * cross-device. `nudge_key` deliberately stays a plain `varchar` (not a
 * Postgres enum) — the fixed key set is validated in `NudgesService.dismiss`,
 * so adding a future moment never needs a migration.
 *
 * `UQ_persona_nudges_user_id_nudge_key (user_id, nudge_key)` makes a dismiss
 * idempotent at the DB level (`ON CONFLICT DO NOTHING`) and doubles as the
 * leading index for "has this user dismissed this key?"; a separate
 * `IDX_persona_nudges_user_id` backs `GET /nudges/me`'s "all of this user's
 * dismissed keys" + cap-count query. `user_id` cascades on delete, matching
 * the rest of the per-user dismissal/preference tables.
 *
 * Plain CREATE TABLE (no enum ADD VALUE), so a single-phase transactional
 * migration is fine.
 */
export class AddPersonaNudges1786600100000 implements MigrationInterface {
  name = 'AddPersonaNudges1786600100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "persona_nudges" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "nudge_key" character varying NOT NULL,
        "dismissed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_persona_nudges" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_persona_nudges_user_id_nudge_key" UNIQUE ("user_id", "nudge_key")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_persona_nudges_user_id" ON "persona_nudges" ("user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "persona_nudges" ADD CONSTRAINT "FK_persona_nudges_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "persona_nudges" DROP CONSTRAINT "FK_persona_nudges_user_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_persona_nudges_user_id"`);
    await queryRunner.query(`DROP TABLE "persona_nudges"`);
  }
}
