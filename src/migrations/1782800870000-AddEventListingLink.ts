import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEventListingLink1782800870000 implements MigrationInterface {
  name = 'AddEventListingLink1782800870000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "events" ADD "listing_id" uuid`);
    await queryRunner.query(
      `CREATE INDEX "IDX_events_listing_id" ON "events" ("listing_id")`,
    );
    // ON DELETE SET NULL: removing a listing must not delete its events, just
    // unlink them (the event still happened / can be re-homed).
    await queryRunner.query(
      `ALTER TABLE "events" ADD CONSTRAINT "FK_events_listing_id" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "events" DROP CONSTRAINT "FK_events_listing_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_events_listing_id"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN "listing_id"`);
  }
}
