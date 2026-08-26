// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The completion step on `volunteer_signups` (SUS-05).
 *
 * A signup could be pending, accepted or declined and that was the end of it.
 * Nothing recorded whether the person actually turned up on the Saturday, how
 * long they stayed, or who could attest to it, so volunteering earned no
 * recognition, and the answer to a funder's "how many volunteer hours did
 * QueerPulse contribute" was that there was no answer.
 *
 * Four columns, all nullable, all written together by one guarded UPDATE in
 * `VolunteeringService.confirmCompletion`:
 *
 *   - `attended`: did they show up. `false` is a real, recordable answer: a
 *     no-show is worth writing down so the hours total stays honest, and it
 *     closes the signup so the poster is not asked again.
 *   - `hours_contributed`: `numeric(5,2)`, so quarter-hours round-trip. Bound
 *     to 0..24 by a CHECK as well as by the DTO, because the number is the one
 *     a funder will eventually be shown and a self-serve claim of 10,000 hours
 *     must be impossible at every layer, including a future admin console
 *     writing straight to the table.
 *   - `completed_at`: the idempotency marker AND the period key the aggregate
 *     groups on. `WHERE completed_at IS NULL` in the claiming UPDATE is what
 *     makes confirming twice a no-op rather than a double count.
 *   - `completed_by_id`: who attested it. Hours are third-party confirmed by
 *     the opportunity's poster (or a community organiser standing in for them),
 *     never self-declared, which is the whole reason the number is worth
 *     reporting.
 *
 * `completed_by_id` is `ON DELETE SET NULL`, matching
 * `SetNullContentAuthorFksOnUserErasure1794610000000`'s treatment of the
 * poster: erasing the confirmer's account must unlink the name and leave the
 * hours standing, since the contribution belonged to the volunteer.
 *
 * Two CHECK constraints:
 *   - `CK_volunteer_signups_hours_range`: the 0..24 bound above.
 *   - `CK_volunteer_signups_completion`: the completion columns move as a set.
 *     Either nothing is recorded, or `completed_at`, `attended` and
 *     `hours_contributed` are all present. `completed_by_id` is deliberately
 *     left out of the "present" side: the erasure FK above can null it later,
 *     and a constraint that a lawful erasure violates is a constraint that
 *     blocks the erasure.
 *
 * The partial index serves the aggregate read (`volunteerHoursTotals`), which
 * always filters `completed_at IS NOT NULL` and usually a date range on top;
 * confirmed rows will always be a small minority of the table.
 *
 * TRANSACTIONAL. No enum label is added or used here, and the index is a plain
 * `CREATE INDEX` (not `CONCURRENTLY`), so all of it runs in one transaction.
 */
export class AddVolunteerSignupCompletion1795600000000 implements MigrationInterface {
  name = 'AddVolunteerSignupCompletion1795600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" ADD "attended" boolean`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" ADD "hours_contributed" numeric(5,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" ADD "completed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" ADD "completed_by_id" uuid`,
    );

    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" ADD CONSTRAINT "FK_volunteer_signups_completed_by_id" FOREIGN KEY ("completed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" ADD CONSTRAINT "CK_volunteer_signups_hours_range" CHECK ("hours_contributed" IS NULL OR ("hours_contributed" >= 0 AND "hours_contributed" <= 24))`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" ADD CONSTRAINT "CK_volunteer_signups_completion" CHECK (
         ("completed_at" IS NULL AND "attended" IS NULL AND "hours_contributed" IS NULL AND "completed_by_id" IS NULL)
         OR ("completed_at" IS NOT NULL AND "attended" IS NOT NULL AND "hours_contributed" IS NOT NULL)
       )`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_volunteer_signups_completed_at" ON "volunteer_signups" ("completed_at") WHERE "completed_at" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // A real undo: every object added above is dropped, and dropping the
    // columns drops the recorded attendance with them. That data loss is the
    // honest consequence of reverting the feature, and it is stated here
    // rather than worked around.
    await queryRunner.query(`DROP INDEX "IDX_volunteer_signups_completed_at"`);
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" DROP CONSTRAINT "CK_volunteer_signups_completion"`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" DROP CONSTRAINT "CK_volunteer_signups_hours_range"`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" DROP CONSTRAINT "FK_volunteer_signups_completed_by_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" DROP COLUMN "completed_by_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" DROP COLUMN "completed_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" DROP COLUMN "hours_contributed"`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" DROP COLUMN "attended"`,
    );
  }
}
