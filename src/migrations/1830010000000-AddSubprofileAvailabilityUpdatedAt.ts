// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-435: one additive, nullable column on `subprofiles` recording when the
 * persona's `availability` or its therapist status
 * (`skin_data -> 'therapist' ->> 'status'`) last changed. The therapist
 * cards' "Also worth a look" list shows it beside the status chip and stops
 * trusting a status older than 60 days.
 *
 * The persona save stamps it whenever either value moves, or when the owner
 * confirms the status as it stands (`availabilityUpdatedAtAfterSave`).
 *
 * No backfill: existing rows stay NULL and read as "Status not confirmed
 * recently" until the owner changes or confirms the status. `updated_at`
 * moves on any save (a bio, a link, a repair script), so copying it would
 * show exactly the false freshness this column exists to stop.
 */
export class AddSubprofileAvailabilityUpdatedAt1830010000000 implements MigrationInterface {
  name = 'AddSubprofileAvailabilityUpdatedAt1830010000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "subprofiles"
        ADD COLUMN "availability_updated_at" TIMESTAMP WITH TIME ZONE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "subprofiles" DROP COLUMN "availability_updated_at"
    `);
  }
}
