// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Turns `volunteer_opportunities.cause` (one enum) into `causes` (an array of
 * one to three), and indexes it for the overlap filter.
 *
 * WHY. Real volunteering rarely sits in one box. A peer-support line for young
 * trans people is Youth AND Trans care AND Mental health, and forcing the
 * poster to pick one both mis-files the opportunity and hides it from two of
 * the three chips someone would look under. Widening the taxonomy
 * (`AddVolunteerOpportunityCauseValues1817050000000`) made this worse rather
 * than better: more boxes, still only one pick.
 *
 * ORDER IS MEANINGFUL, and this is the reason for an array rather than a join
 * table. `causes[0]` is the cause the poster led with; the card prints it
 * first and takes its avatar tint from it. A join table would have needed a
 * position column to say the same thing, plus a join on every list query, to
 * hold at most three values that are only ever read all-at-once with the row.
 *
 * THE CAP OF THREE IS NOT IN THE SCHEMA. `CreateOpportunityDto` /
 * `UpdateOpportunityDto` enforce `@ArrayNotEmpty` + `@ArrayMaxSize(3)` at the
 * request boundary. A CHECK constraint here would turn a future editorial
 * decision to allow four into a migration on a locked table, and there is no
 * second writer: the seed and the two DTOs are the only things that write this
 * column.
 *
 * BACKFILL. `causes = ARRAY[cause]`. Every existing row keeps exactly the
 * cause it had, in first position, so nothing on screen changes for content
 * posted before today. This statement only ever writes labels that already
 * existed before 1817050000000, which is why it is safe for this migration to
 * run inside a transaction even though the enum was widened moments earlier:
 * the "new value cannot be used in the same transaction" rule bites on the
 * eight NEW labels, and none of them appear here.
 *
 * NOT NULL WITHOUT A DEFAULT, deliberately. The column is added nullable,
 * backfilled, and only then made `NOT NULL`, so the constraint is proven by
 * the data rather than papered over by a `'{}'` default that would let a
 * causeless opportunity exist. An empty array is not a valid state: every
 * opportunity has at least one cause, which is what `@ArrayNotEmpty` says at
 * the other end.
 *
 * GIN INDEX, because the list filter is now
 * `causes && ARRAY[:cause]::volunteer_opportunities_cause_enum[]`. A btree
 * cannot serve an overlap test; GIN is the index type for `&&` on arrays.
 * Plain `CREATE INDEX`, not `CONCURRENTLY`: this migration already takes an
 * ACCESS EXCLUSIVE lock to drop `cause`, so a concurrent build (which would
 * force the whole migration non-transactional, and could leave an INVALID
 * index behind on failure) would buy nothing.
 */
export class VolunteerOpportunityMultipleCauses1817060000000 implements MigrationInterface {
  name = 'VolunteerOpportunityMultipleCauses1817060000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "volunteer_opportunities"
        ADD COLUMN IF NOT EXISTS "causes" "volunteer_opportunities_cause_enum"[]
    `);
    await queryRunner.query(`
      UPDATE "volunteer_opportunities"
         SET "causes" = ARRAY["cause"]
       WHERE "causes" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "volunteer_opportunities"
        ALTER COLUMN "causes" SET NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_volunteer_opportunities_causes"
        ON "volunteer_opportunities" USING GIN ("causes")
    `);
    await queryRunner.query(`
      ALTER TABLE "volunteer_opportunities" DROP COLUMN IF EXISTS "cause"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reversible with one documented loss: an opportunity that claimed more
    // than one cause comes back holding only the first. That is the best any
    // revert can do against a column that no longer exists, and it is why the
    // first position is the one the frontend treats as primary.
    await queryRunner.query(`
      ALTER TABLE "volunteer_opportunities"
        ADD COLUMN IF NOT EXISTS "cause" "volunteer_opportunities_cause_enum"
    `);
    await queryRunner.query(`
      UPDATE "volunteer_opportunities"
         SET "cause" = "causes"[1]
       WHERE "cause" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "volunteer_opportunities"
        ALTER COLUMN "cause" SET NOT NULL
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_volunteer_opportunities_causes"`,
    );
    await queryRunner.query(`
      ALTER TABLE "volunteer_opportunities" DROP COLUMN IF EXISTS "causes"
    `);
  }
}
