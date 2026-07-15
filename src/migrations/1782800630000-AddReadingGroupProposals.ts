import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `reading_group_proposal`, backing `POST /reading-groups/proposals`
 * (see `src/community/`). The Reading Groups page
 * (`queerpulse/src/features/community/ReadingGroupsPage.tsx`) lists a
 * curated group directory with no server-backed listing — this is the one
 * genuine member-submitted data point on the page (the "Start your own
 * group" strip in `ListGroupStrip.tsx`).
 *
 * DO NOT RUN — authored for review only, per the task's instructions.
 */
export class AddReadingGroupProposals1782800630000 implements MigrationInterface {
  name = 'AddReadingGroupProposals1782800630000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "reading_group_proposal_format_enum" AS ENUM (
        'In-person', 'Online', 'Either'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "reading_group_proposal" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "member_id" uuid NOT NULL,
        "book" character varying(200) NOT NULL,
        "why" character varying(500),
        "format" "reading_group_proposal_format_enum" NOT NULL,
        "max_people" smallint NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reading_group_proposal" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_reading_group_proposal_member_id" ON "reading_group_proposal" ("member_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "reading_group_proposal" ADD CONSTRAINT "FK_reading_group_proposal_member_id"
        FOREIGN KEY ("member_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reading_group_proposal" DROP CONSTRAINT "FK_reading_group_proposal_member_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_reading_group_proposal_member_id"`,
    );
    await queryRunner.query(`DROP TABLE "reading_group_proposal"`);
    await queryRunner.query(`DROP TYPE "reading_group_proposal_format_enum"`);
  }
}
