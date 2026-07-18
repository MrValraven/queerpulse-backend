import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Member-hosted workshops — the catalogue behind the frontend's Skills &
 * learning page. Shape is derived from the frontend's `Workshop` type
 * (`src/features/economy/workshops.data.ts`) and its builder
 * (`addWorkshop.build.ts`).
 *
 * Two shape decisions worth recording:
 *
 *  - **Money is numeric, never a formatted string.** The frontend carries
 *    `price: "€180"` and `tiers[].amount: "€120"`; here `price` is `numeric`
 *    with a `currency` beside it, and `tiers[].amount` inside the jsonb is a
 *    number. This follows `jobs`, which keeps `salary` (display) strictly
 *    separate from `rate_min`/`rate_max`/`currency` (structured) — formatting
 *    is the client's job, and it already owns the `Formatters.currency` that
 *    does it.
 *
 *  - **Derived i18n chrome is not stored.** The frontend's `format`
 *    ("Workshop · 6 weeks · group of 8") is composed client-side from the
 *    week count and cohort size, so this table stores `weeks` and
 *    `spots_total` and lets the client compose the sentence in the viewer's
 *    language. `price_sub`/`start_date`/`cancellation` are nullable for the
 *    same reason: NULL means "host supplied nothing, render your own i18n
 *    default", a value is the host's own words.
 *
 * **`host_id` is `ON DELETE CASCADE`**, matching `events.host_id` (the closest
 * precedent — also a scheduled, host-led gathering people plan to attend) and
 * `jobs.poster_id`/`listings.owner_id`. Since `AddDeletionErasureSupport`
 * (1782800700000) an erasure genuinely hard-deletes the `users` row, so this
 * choice is load-bearing rather than theoretical, and CASCADE is right here:
 *
 *  1. A workshop is not content that stands alone — it is a commitment to
 *     turn up and teach. With the host erased there is nobody to deliver it,
 *     so an orphaned row would keep advertising sessions in the catalogue
 *     that can never happen, and keep taking reservations for them. An empty
 *     row is a worse outcome for an attendee than a removed one.
 *  2. `SET NULL` would also have to make `host_id` nullable, which silently
 *     breaks the host-only authorization on PATCH/DELETE: a NULL host matches
 *     nobody, leaving the row permanently unowned — uneditable and
 *     undeletable by any member, including moderators, who have no route here.
 *  3. The retention argument that won `SET NULL` for `reports.reporter_id`
 *     and `mod_audit_logs.actor_id` does not apply. Those are evidence
 *     *about other people* that erasure must not be allowed to wipe. A
 *     workshop is the host's own listing — their words, their venue, their
 *     professional description in `host_role` — and erasure should take it.
 *
 * Caveat for whoever adds reservations: attendee rows should be
 * `ON DELETE CASCADE` to `workshops`, and the erasure sweep will need to
 * notify affected attendees before the cascade removes their booking. Nothing
 * depends on that today — reservation is still a frontend-only flow — but the
 * cascade is what makes the notification a requirement rather than an option.
 */
export class AddWorkshops1782800750000 implements MigrationInterface {
  name = 'AddWorkshops1782800750000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "workshop_mode_enum" AS ENUM('in_person', 'online', 'hybrid')`,
    );
    await queryRunner.query(
      `CREATE TYPE "workshop_hero_tint_enum" AS ENUM('default', 'coral', 'jade', 'plum')`,
    );

    await queryRunner.query(`
      CREATE TABLE "workshops" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "host_id" uuid NOT NULL,
        "host_role" character varying,
        "cat" character varying NOT NULL,
        "title" character varying NOT NULL,
        "title_em" character varying NOT NULL DEFAULT '',
        "mode" "workshop_mode_enum" NOT NULL,
        "weeks" integer NOT NULL,
        "spots_total" integer NOT NULL,
        "spots_filled" integer NOT NULL DEFAULT 0,
        "blurb" text NOT NULL,
        "about" text array NOT NULL DEFAULT '{}',
        "hero_placeholder" character varying,
        "hero_tint" "workshop_hero_tint_enum" NOT NULL DEFAULT 'default',
        "price" numeric NOT NULL DEFAULT 0,
        "currency" character varying NOT NULL DEFAULT 'EUR',
        "price_sub" character varying,
        "start_date" character varying,
        "cancellation" character varying,
        "tiers" jsonb NOT NULL DEFAULT '[]',
        "sessions" jsonb NOT NULL DEFAULT '[]',
        "needs" jsonb NOT NULL DEFAULT '[]',
        "past_work" text array NOT NULL DEFAULT '{}',
        "tags" text array NOT NULL DEFAULT '{}',
        "location" jsonb NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_workshops" PRIMARY KEY ("id")
      )
    `);

    // The unique index is the real backstop behind
    // `WorkshopsService.createWithUniqueSlug`'s pre-check + 23505 retry loop
    // (a concurrent create can race past the pre-check).
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workshops_slug" ON "workshops" ("slug")`,
    );
    // Backs the block/mute `NOT EXISTS` join on `host_id` in the list query.
    await queryRunner.query(
      `CREATE INDEX "IDX_workshops_host_id" ON "workshops" ("host_id")`,
    );
    // The catalogue's only filter (`GET /workshops?cat=`), ordered by recency.
    await queryRunner.query(
      `CREATE INDEX "IDX_workshops_cat" ON "workshops" ("cat")`,
    );

    await queryRunner.query(
      `ALTER TABLE "workshops" ADD CONSTRAINT "FK_workshops_host_id" FOREIGN KEY ("host_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workshops" DROP CONSTRAINT "FK_workshops_host_id"`,
    );
    await queryRunner.query(`DROP TABLE "workshops"`);
    await queryRunner.query(`DROP TYPE "workshop_hero_tint_enum"`);
    await queryRunner.query(`DROP TYPE "workshop_mode_enum"`);
  }
}
