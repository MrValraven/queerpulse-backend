// Applied at backend boot while pending: `ensureDatabaseSchema` (called from
// `src/main.ts`) runs every pending migration at startup unless
// `AUTO_RUN_MIGRATIONS=false` is set. To apply it by hand instead, set that
// flag, check `pnpm run typeorm migration:show`, then `pnpm run migration:run`.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `magazine_issue.closes_on`: the day an issue stops taking copy.
 *
 * WHY THE COLUMN EXISTS. The editor desk header reads "Closes 14 Aug · 9 days
 * left" in demo mode, and live mode blanked the line because nothing in the
 * database held a close date. `submission_deadline` is the last day for
 * PITCHES (the public submit-story form), and `published_on` is when the
 * issue goes out. The day the desk stops accepting filed pieces sits between
 * the two, and by how much is an editorial decision nobody had recorded.
 *
 * NULLABLE ON PURPOSE, with no backfill, matching `submission_deadline`'s
 * NULL-means-unset contract. Every existing issue gets NULL, and the desk
 * shows no countdown until an editor sets a date. A fabricated default would
 * have the desk counting down to a day nobody agreed to.
 *
 * Transactional: a single nullable `ADD COLUMN` takes no table rewrite and
 * builds no index.
 */
export class AddMagazineIssueClosesOn1823400000000 implements MigrationInterface {
  name = 'AddMagazineIssueClosesOn1823400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_issue" ADD "closes_on" date`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_issue" DROP COLUMN "closes_on"`,
    );
  }
}
