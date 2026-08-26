// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops `coop_relocation_requests` (LOC-19, queue 4 of four).
 *
 * The audit found four member-submitted things that reached the database and
 * stopped. Three were completed: their consoles were built, decisions were
 * given reasons, and submitters are now told. This fourth one was removed
 * instead, on the maintainer's call, because the claim was stronger than the
 * audit stated: there was **no submission affordance either**. `POST
 * /housing/coops/:slug/relocation-requests` had no frontend caller anywhere,
 * so the table has always been empty, and neither admin route
 * (`GET /admin/housing/relocation-requests`,
 * `PATCH /admin/housing/relocation-requests/:id`) had one.
 *
 * Building it out would have cost a member form, an admin console, a
 * notification type and a push formatter, in the most safety-sensitive domain
 * on the platform, for something nobody has ever been able to use. It also
 * duplicated the live `src/intakes/` triage pipeline. If the need becomes real,
 * one new `INTAKE_KINDS` value (`coop_relocation`) inherits staff triage,
 * assignment and SLAs for free, rather than a second parallel queue.
 *
 * ONLY the relocation half is dropped here.
 * `AddCoopOperatorToolsAndRelocation1787900100000` also added the co-op
 * operator-tool columns, which are in use and stay. That migration is applied
 * history and is not edited: this is a new, additive step forward.
 *
 * `down()` restores the table exactly as `1787900100000` created it (same
 * columns, enum, indexes and FK semantics), so the schema is reversible even
 * though the rows are not. Dropping an always-empty table means there is no
 * data to preserve, but verify with
 * `SELECT count(*) FROM coop_relocation_requests;` before running: a non-zero
 * count would mean somebody reached the endpoint directly, and this should be
 * reconsidered rather than run.
 */
export class DropCoopRelocationRequests1794810000000 implements MigrationInterface {
  name = 'DropCoopRelocationRequests1794810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "coop_relocation_requests"`);
    await queryRunner.query(`DROP TYPE "coop_relocation_requests_status_enum"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "coop_relocation_requests_status_enum" AS ENUM('open','resolved','dismissed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "coop_relocation_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "coop_id" uuid NOT NULL,
        "name" character varying NOT NULL,
        "situation" text NOT NULL,
        "user_id" uuid,
        "status" "coop_relocation_requests_status_enum" NOT NULL DEFAULT 'open',
        "outcome" text,
        "resolved_by_user_id" uuid,
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coop_relocation_requests" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_coop_relocation_requests_coop_id" ON "coop_relocation_requests" ("coop_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_coop_relocation_requests_user_id" ON "coop_relocation_requests" ("user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "coop_relocation_requests" ADD CONSTRAINT "FK_coop_relocation_requests_coop_id" FOREIGN KEY ("coop_id") REFERENCES "housing_coops"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "coop_relocation_requests" ADD CONSTRAINT "FK_coop_relocation_requests_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }
}
