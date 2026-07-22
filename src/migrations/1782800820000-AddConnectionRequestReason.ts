import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConnectionRequestReason1782800820000 implements MigrationInterface {
  name = 'AddConnectionRequestReason1782800820000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Why the requester reached out — an "open to" preset (`open:<id>`), a
    // member's own words (`custom:<label>`), or a generic reason id. Free-form
    // text, so stored as-is and surfaced to the addressee on the incoming card.
    await queryRunner.query(
      `ALTER TABLE "connections" ADD "request_reason" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "connections" DROP COLUMN "request_reason"`,
    );
  }
}
