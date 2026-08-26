import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes the workshops capability from the schema.
 *
 * The product decision (LOC-14) is that workshops are not shipping: the
 * `/work/skills` board, the workshop page, the RSVP/waitlist flow, the
 * `WorkshopsModule`, its search kind and its public-eligibility signal have all
 * been deleted from both repos. Two tables outlive the code they served, so
 * they go here.
 *
 * ## THIS MIGRATION DESTROYS DATA
 *
 * `DROP TABLE "workshops"` and `DROP TABLE "workshop_rsvps"` take every hosted
 * workshop and every seat reservation with them. There is no archive step and
 * no export: the feature never left the frontend-plus-demo stage, so in any
 * environment where it was only ever browsed these tables are empty, but this
 * migration cannot know that and does not check. Confirm the row counts before
 * running it:
 *
 * ```sql
 * SELECT (SELECT count(*) FROM workshops)      AS workshops,
 *        (SELECT count(*) FROM workshop_rsvps) AS rsvps;
 * ```
 *
 * ## What `down()` restores, and what it cannot
 *
 * `down()` recreates both tables, their enum types, their indexes and their
 * foreign keys — the schema exactly as it stood immediately before `up()`, so
 * the migration chain around it stays revertible. It restores **no rows**. A
 * revert gives back an empty catalogue, not the one that was dropped.
 *
 * Three details `down()` has to get right, none of them obvious from
 * `AddWorkshops1782800750000` alone:
 *
 *  1. **No `spots_filled` column.** `AddWorkshopRsvps1782800780000` dropped it
 *     and replaced the denormalized counter with a `COUNT(*)` over
 *     `workshop_rsvps`. Re-adding it here would resurrect a column that the
 *     state before this migration did not have.
 *
 *  2. **`host_id` is nullable with `ON DELETE SET NULL`.**
 *     `SetNullContentAuthorFksOnUserErasure1794610000000` converted
 *     `FK_workshops_host_id` from CASCADE to SET NULL and dropped the column's
 *     NOT NULL. It carries an earlier timestamp than this migration, so
 *     TypeORM runs it first and the shape it leaves behind is the shape this
 *     `down()` must reproduce. (If that migration is ever removed rather than
 *     run, this `down()` needs the original `uuid NOT NULL` + CASCADE back.)
 *
 *  3. **The two trigram indexes come back too.**
 *     `AddGlobalSearchTrgmIndexes1785800300000` created
 *     `IDX_workshops_title_trgm` and `IDX_workshops_blurb_trgm`, and its own
 *     `down()` drops them by name. Recreating them keeps that revert from
 *     failing on indexes this migration would otherwise have taken away
 *     silently with the table. They are recreated WITHOUT `CONCURRENTLY`: a
 *     revert path builds them on a table that has just been recreated empty,
 *     where the lock a plain `CREATE INDEX` takes costs nothing, and keeping
 *     `CONCURRENTLY` out means this migration stays fully transactional.
 */
export class DropWorkshops1794750000000 implements MigrationInterface {
  name = 'DropWorkshops1794750000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Child first: `workshop_rsvps.workshop_id` references `workshops`.
    // Dropping a table drops its own constraints and indexes with it, so the
    // FKs and indexes declared by the two Add* migrations need no separate
    // statement here.
    await queryRunner.query(`DROP TABLE "workshop_rsvps"`);
    await queryRunner.query(`DROP TABLE "workshops"`);

    await queryRunner.query(`DROP TYPE "workshop_rsvp_status_enum"`);
    await queryRunner.query(`DROP TYPE "workshop_hero_tint_enum"`);
    await queryRunner.query(`DROP TYPE "workshop_mode_enum"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
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
        "host_id" uuid,
        "host_role" character varying,
        "cat" character varying NOT NULL,
        "title" character varying NOT NULL,
        "title_em" character varying NOT NULL DEFAULT '',
        "mode" "workshop_mode_enum" NOT NULL,
        "weeks" integer NOT NULL,
        "spots_total" integer NOT NULL,
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

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workshops_slug" ON "workshops" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workshops_host_id" ON "workshops" ("host_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workshops_cat" ON "workshops" ("cat")`,
    );
    // See (3) in the header: recreated non-concurrently on purpose.
    await queryRunner.query(
      `CREATE INDEX "IDX_workshops_title_trgm" ` +
        `ON "workshops" USING gin ("title" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workshops_blurb_trgm" ` +
        `ON "workshops" USING gin ("blurb" gin_trgm_ops)`,
    );

    // See (2) in the header: SET NULL, not CASCADE.
    await queryRunner.query(`
      ALTER TABLE "workshops" ADD CONSTRAINT "FK_workshops_host_id"
        FOREIGN KEY ("host_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

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

    await queryRunner.query(
      `CREATE INDEX "IDX_workshop_rsvps_workshop_id" ON "workshop_rsvps" ("workshop_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_workshop_rsvps_user_id" ON "workshop_rsvps" ("user_id")`,
    );

    await queryRunner.query(`
      ALTER TABLE "workshop_rsvps" ADD CONSTRAINT "FK_workshop_rsvps_workshop_id"
        FOREIGN KEY ("workshop_id") REFERENCES "workshops"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "workshop_rsvps" ADD CONSTRAINT "FK_workshop_rsvps_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }
}
