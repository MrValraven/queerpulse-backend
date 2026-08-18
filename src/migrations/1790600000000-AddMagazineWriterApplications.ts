import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `magazine_writer_applications` — a member's application to become
 * a magazine writer (pitch note + writing sample), triaged by an admin, who
 * on approval grants the existing `magazine_writer` staff role via
 * `AdminMembersService.grantStaffRole`. Mirrors `community_join_requests`
 * (see `AddCommunities1782693200000`): a partial unique index enforces at
 * most one PENDING application per user, so a user can re-apply after a
 * decline while a concurrent double-submit is rejected with a 23505 the
 * service maps to 409.
 *
 * DO NOT RUN. Authored for review only; the maintainer runs migrations.
 */
export class AddMagazineWriterApplications1790600000000
  implements MigrationInterface
{
  name = 'AddMagazineWriterApplications1790600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "magazine_writer_applications_status_enum" AS ENUM('pending', 'approved', 'declined')`,
    );
    await queryRunner.query(`
      CREATE TABLE "magazine_writer_applications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "pitch_note" text,
        "sample_text" text,
        "sample_link" character varying,
        "status" "magazine_writer_applications_status_enum" NOT NULL DEFAULT 'pending',
        "reviewed_by" uuid,
        "review_note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "reviewed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_magazine_writer_applications" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_writer_applications_user_id" ON "magazine_writer_applications" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_magazine_writer_applications_pending" ` +
        `ON "magazine_writer_applications" ("user_id") WHERE "status" = 'pending'`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_writer_applications" ADD CONSTRAINT "FK_magazine_writer_applications_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_writer_applications" ADD CONSTRAINT "FK_magazine_writer_applications_reviewed_by" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_writer_applications" DROP CONSTRAINT "FK_magazine_writer_applications_reviewed_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_writer_applications" DROP CONSTRAINT "FK_magazine_writer_applications_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "UQ_magazine_writer_applications_pending"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_magazine_writer_applications_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "magazine_writer_applications"`);
    await queryRunner.query(
      `DROP TYPE "magazine_writer_applications_status_enum"`,
    );
  }
}
