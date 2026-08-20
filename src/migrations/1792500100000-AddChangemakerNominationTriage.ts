import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds triage columns to `changemaker_nomination` — COM-17: nominations were
 * a one-way black hole (a submit toast, then silence forever; the only admin
 * surface was a read-only list, `AdminChangemakerNominationsController`).
 * Mirrors `magazine_writer_applications` (`AddMagazineWriterApplications
 * 1790600000000`): `status` defaults every existing row to `'pending'`
 * (nothing has been triaged yet), `reviewed_by`/`review_note`/`reviewed_at`
 * stay null until an admin acts. Unlike the writer-application table, there
 * is no partial-unique "one pending row" constraint — a member can nominate
 * more than one person, so multiple pending rows per nominator are normal.
 *
 * Also adds `changemaker_nomination_approved`/`changemaker_nomination_
 * dismissed` to `notifications_type_enum`, sent to the nominator when an
 * admin decides their nomination (`AdminChangemakerNominationsService.
 * triage`). Additive ADD VALUE only, mirrors `AddWriterApplicationNotification
 * Types1790700000000` — safe inside the migration transaction on
 * PostgreSQL 12+; `down()` for that part is a documented no-op (Postgres
 * cannot drop an enum value).
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddChangemakerNominationTriage1792500100000 implements MigrationInterface {
  name = 'AddChangemakerNominationTriage1792500100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "changemaker_nomination_status_enum" AS ENUM('pending', 'approved', 'dismissed')`,
    );
    await queryRunner.query(
      `ALTER TABLE "changemaker_nomination" ADD "status" "changemaker_nomination_status_enum" NOT NULL DEFAULT 'pending'`,
    );
    await queryRunner.query(
      `ALTER TABLE "changemaker_nomination" ADD "reviewed_by" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "changemaker_nomination" ADD "review_note" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "changemaker_nomination" ADD "reviewed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "changemaker_nomination" ADD CONSTRAINT "FK_changemaker_nomination_reviewed_by" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'changemaker_nomination_approved'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'changemaker_nomination_dismissed'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No-op for the notification-type values: Postgres cannot drop an enum
    // value; the added values are harmless if left in place.
    await queryRunner.query(
      `ALTER TABLE "changemaker_nomination" DROP CONSTRAINT "FK_changemaker_nomination_reviewed_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "changemaker_nomination" DROP COLUMN "reviewed_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "changemaker_nomination" DROP COLUMN "review_note"`,
    );
    await queryRunner.query(
      `ALTER TABLE "changemaker_nomination" DROP COLUMN "reviewed_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "changemaker_nomination" DROP COLUMN "status"`,
    );
    await queryRunner.query(`DROP TYPE "changemaker_nomination_status_enum"`);
  }
}
