// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-110 / PRD-126 — adds `magazine_issue.last_ship`, the report from the
 * most recent `shipIssue` run.
 *
 * A ship used to publish silently: pieces it skipped (behind the care gate,
 * still drafting, missing a standfirst) looked exactly like pieces it
 * published, and nothing survived the request, so a reload of the production
 * page showed an editor no trace of what had just happened. This column holds
 * `IssueLastShip` — when the ship ran, when its pieces go live (09:00
 * Europe/Lisbon on a future issue date), which pieces published, and every
 * held piece with its reasons.
 *
 * Nullable with no default: NULL means "never shipped", which stays
 * distinguishable from a ship that published nothing.
 */
export class AddMagazineIssueLastShip1806210000000 implements MigrationInterface {
  name = 'AddMagazineIssueLastShip1806210000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_issue" ADD COLUMN "last_ship" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_issue" DROP COLUMN "last_ship"`,
    );
  }
}
