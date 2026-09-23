import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a "where did you hear about QueerPulse" answer to platform join
 * requests.
 *
 * The applicant writes it in their own words, and the admin queue shows it to
 * reviewers as context beside the request. It is self-reported free text, so
 * it sits apart from `source` (the frontend entry point the applicant came
 * through), which the frontend records on its own.
 *
 * Nullable with no default and no backfill: rows submitted before this column
 * existed carry no answer, and inventing one would put words in an
 * applicant's mouth. `CreateMembershipJoinRequestDto` is what makes the field
 * required for every request going forward.
 */
export class AddJoinRequestHeardFrom1821400200000 implements MigrationInterface {
  name = 'AddJoinRequestHeardFrom1821400200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        ADD "heard_from" character varying(200)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        DROP COLUMN "heard_from"
    `);
  }
}
