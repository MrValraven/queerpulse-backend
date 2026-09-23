// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `reading_group_proposal.club_name`: the proposal form's optional "Club
 * name". Approval names the new community after it, and falls back to the
 * first book's title when it is NULL, which is what every existing row keeps.
 * A nullable ADD COLUMN with no default is catalog-only on PostgreSQL.
 */
export class AddReadingGroupProposalClubName1821700100000 implements MigrationInterface {
  name = 'AddReadingGroupProposalClubName1821700100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reading_group_proposal" ADD "club_name" character varying(200)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reading_group_proposal" DROP COLUMN "club_name"`,
    );
  }
}
