// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Top listeners become default-on: every eligible listener of an artist
 * persona is ranked as their account, and a `studio_supporters` row now
 * stores a preference for one artist. `shown_as_subprofile_id` keeps the
 * chosen identity and the new `is_hidden` column turns the member off that
 * artist's list while keeping the identity, so turning it back on restores
 * it. Every existing row was an opt-in, so they all stay shown (false).
 *
 * The ranking reads hidden rows through the primary key on
 * (`user_id`, `subprofile_id`), so the column needs no index of its own. The
 * constant default makes the column add a catalog change only.
 */
export class AddStudioSupporterHidden1838600000000 implements MigrationInterface {
  name = 'AddStudioSupporterHidden1838600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "studio_supporters" ADD COLUMN "is_hidden" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // A hidden row means "leave me off this artist's list". Without the
    // column a row reads as an opt-in, so hidden rows are removed first.
    await queryRunner.query(
      `DELETE FROM "studio_supporters" WHERE "is_hidden" = true`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_supporters" DROP COLUMN "is_hidden"`,
    );
  }
}
