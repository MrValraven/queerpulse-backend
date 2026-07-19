import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reservations for workshops — the thing `AddWorkshops` (1782800750000) left
 * for "whoever adds reservations", and the reason its delete-confirmation copy
 * had to admit that nobody gets told when a workshop disappears.
 *
 * Three changes:
 *
 * 1. **`workshop_rsvps`** — one row per (workshop, member), modelled on
 *    `event_rsvps` (1782691900000). Same UNIQUE (parent, user) pair, same
 *    retained-`cancelled` status rather than deleting rows. The status enum
 *    drops `maybe` and renames `waitlisted` to `waitlist`; see the entity for
 *    why a workshop seat has no "maybe".
 *
 * 2. **`workshops.spots_filled` is dropped.** It was an `integer NOT NULL
 *    DEFAULT 0` that nothing ever incremented — `WorkshopsService.create` set
 *    it to 0 and no code path moved it, because reservation was a frontend-only
 *    flow. Now that real rows record who is attending, keeping the column would
 *    mean maintaining a denormalized counter beside the rows it counts, and any
 *    interrupted transaction, manual DELETE, or user erasure (below) would drift
 *    it away from the truth. `spots_filled` is derived with a `COUNT(*)` over
 *    `status = 'going'` instead, which is the pattern `volunteering` already
 *    uses (`VolunteeringService.spotsFilledFor`/`spotsFilledForMany`).
 *
 *    Nothing is backfilled because there is nothing to backfill *from*: the old
 *    column recorded a number with no attendee identities behind it, so every
 *    value it held was necessarily 0.
 *
 * 3. **Both FKs are `ON DELETE CASCADE`**, which is what makes erasure correct
 *    without the sweep knowing this table exists:
 *
 *    - `workshop_id → workshops` — `AddWorkshops` asked for exactly this. A
 *      workshop is hard-deleted (`WorkshopsService.remove`), and a booking for
 *      a workshop that no longer exists is not a record worth keeping; it would
 *      be an orphan pointing at nothing that still counted against nothing.
 *      Note this cascades *transitively* on host erasure: `workshops.host_id`
 *      is already `ON DELETE CASCADE`, so erasing a host removes their
 *      workshops, which removes every booking on them.
 *    - `user_id → users` — since `AddDeletionErasureSupport` (1782800700000)
 *      the erasure sweep genuinely hard-deletes the `users` row
 *      (`AccountDeletionProcessorService` ends in `manager.delete(User, …)`)
 *      and relies entirely on FK cascade to clear the member's traces; it does
 *      not enumerate tables. CASCADE is therefore the whole erasure story for
 *      this table, and it is the right rule: an attendee list is a record of
 *      *who is in a room*, i.e. personal data about the erased member, not
 *      evidence about anyone else. None of the retention argument that won
 *      `SET NULL` for `reports.reporter_id` applies.
 *
 *    The consequence `AddWorkshops` flagged — that an erased host's attendees
 *    lose their booking silently — is still true and still unfixable here:
 *    there is no email service and no workshop notification type, so nothing
 *    can tell them. That gap is recorded in the delete-confirmation copy, which
 *    now names the number of people affected without claiming any of them are
 *    contacted.
 */
export class AddWorkshopRsvps1782800780000 implements MigrationInterface {
  name = 'AddWorkshopRsvps1782800780000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "workshop_rsvp_status_enum" AS ENUM('going', 'waitlist', 'cancelled')`,
    );

    await queryRunner.query(`
      CREATE TABLE "workshop_rsvps" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "workshop_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "status" "workshop_rsvp_status_enum" NOT NULL,
        "waitlisted_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_workshop_rsvps" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_workshop_rsvps" UNIQUE ("workshop_id", "user_id")
      )
    `);

    // Backs the derived `spots_filled` count, the attendee list, and the
    // waitlist-head lookup — all of which filter by workshop first.
    await queryRunner.query(
      `CREATE INDEX "IDX_workshop_rsvps_workshop_id" ON "workshop_rsvps" ("workshop_id")`,
    );
    // Backs "my booking on this workshop" and the cascade on user erasure.
    await queryRunner.query(
      `CREATE INDEX "IDX_workshop_rsvps_user_id" ON "workshop_rsvps" ("user_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "workshop_rsvps" ADD CONSTRAINT "FK_workshop_rsvps_workshop_id" FOREIGN KEY ("workshop_id") REFERENCES "workshops"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "workshop_rsvps" ADD CONSTRAINT "FK_workshop_rsvps_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // See (2): the stored counter is replaced by a COUNT over the rows above.
    await queryRunner.query(
      `ALTER TABLE "workshops" DROP COLUMN "spots_filled"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restores the column and its default, but deliberately does **not**
    // backfill it from `workshop_rsvps` — the rows are dropped immediately
    // below, and reviving a denormalized counter from data this migration is
    // about to destroy would leave a number nothing can ever reconcile again.
    // Reverting means going back to "reservation is a frontend-only flow",
    // where 0 is the honest value.
    await queryRunner.query(
      `ALTER TABLE "workshops" ADD COLUMN "spots_filled" integer NOT NULL DEFAULT 0`,
    );

    await queryRunner.query(
      `ALTER TABLE "workshop_rsvps" DROP CONSTRAINT "FK_workshop_rsvps_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workshop_rsvps" DROP CONSTRAINT "FK_workshop_rsvps_workshop_id"`,
    );
    await queryRunner.query(`DROP TABLE "workshop_rsvps"`);
    await queryRunner.query(`DROP TYPE "workshop_rsvp_status_enum"`);
  }
}
