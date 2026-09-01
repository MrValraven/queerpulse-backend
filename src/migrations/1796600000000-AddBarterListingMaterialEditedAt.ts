// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `barter_listings.material_edited_at`: when the poster last changed something
 * a proposal was made AGAINST (category, mode, or either headline).
 *
 * Added with the poster's edit path (PRD-42, `PATCH /barter/:id`). A swap was
 * previously uneditable, so nothing could change under a pending proposal;
 * now that it can, the proposer's own view (`GET /barter/mine/proposals`)
 * reads this stamp to tell them the listing moved after they offered, instead
 * of holding them to a deal that quietly became a different one.
 *
 * Nullable with no default and no backfill: every existing row has never been
 * materially edited, which is exactly what NULL means here.
 *
 * Plain `ADD COLUMN` of a nullable column takes only a brief ACCESS EXCLUSIVE
 * lock and rewrites nothing, so this stays inside the migration's single
 * transaction, so no `CREATE INDEX CONCURRENTLY` two-phase split is needed.
 */
export class AddBarterListingMaterialEditedAt1796600000000 implements MigrationInterface {
  name = 'AddBarterListingMaterialEditedAt1796600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "barter_listings"
        ADD COLUMN "material_edited_at" TIMESTAMP WITH TIME ZONE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "barter_listings" DROP COLUMN "material_edited_at"
    `);
  }
}
