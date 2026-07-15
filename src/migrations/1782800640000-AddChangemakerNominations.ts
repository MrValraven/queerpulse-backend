import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `changemaker_nomination`, backing `POST /changemakers/nominations`
 * (see `src/community/`). The Change Makers page
 * (`queerpulse/src/features/community/ChangemakersPage.tsx`) profiles a
 * curated directory with no server-backed listing — this is the one genuine
 * member-submitted data point on the page (the "Nominate them" form).
 *
 * DO NOT RUN — authored for review only, per the task's instructions.
 */
export class AddChangemakerNominations1782800640000 implements MigrationInterface {
  name = 'AddChangemakerNominations1782800640000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "changemaker_nomination" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "nominator_id" uuid NOT NULL,
        "nominee_name" character varying(200) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_changemaker_nomination" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_changemaker_nomination_nominator_id" ON "changemaker_nomination" ("nominator_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "changemaker_nomination" ADD CONSTRAINT "FK_changemaker_nomination_nominator_id"
        FOREIGN KEY ("nominator_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "changemaker_nomination" DROP CONSTRAINT "FK_changemaker_nomination_nominator_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_changemaker_nomination_nominator_id"`,
    );
    await queryRunner.query(`DROP TABLE "changemaker_nomination"`);
  }
}
