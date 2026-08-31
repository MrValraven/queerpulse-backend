import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `reason` to `changemaker_nomination` — COM-16: the "Nominate them"
 * form's copy promises "a name and a sentence is enough to start"
 * (`community:changemakers.nominate.lead`), but the form and the backend
 * only ever captured the nominee's name. Nullable: existing rows were
 * submitted before this field existed and have nothing to backfill;
 * `CreateChangemakerNominationDto.reason` requires it going forward so every
 * new nomination actually carries what the copy promises reviewers will see.
 */
export class AddChangemakerNominationReason1792500000000 implements MigrationInterface {
  name = 'AddChangemakerNominationReason1792500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "changemaker_nomination" ADD "reason" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "changemaker_nomination" DROP COLUMN "reason"`,
    );
  }
}
