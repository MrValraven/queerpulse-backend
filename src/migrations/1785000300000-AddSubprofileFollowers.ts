import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Subprofiles Phase 3b: `subprofile_followers` — a lean, hard-delete-on-unfollow
 * mirror of `subprofile_endorsements` (no note, no soft-withdraw: a follow
 * needs no history). See
 * `src/subprofiles/entities/subprofile-follower.entity.ts`.
 */
export class AddSubprofileFollowers1785000300000 implements MigrationInterface {
  name = 'AddSubprofileFollowers1785000300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "subprofile_followers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subprofile_id" uuid NOT NULL,
        "follower_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subprofile_followers" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_subprofile_followers" UNIQUE ("subprofile_id", "follower_id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_subprofile_followers_subprofile_id" ON "subprofile_followers" ("subprofile_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_subprofile_followers_follower_id" ON "subprofile_followers" ("follower_id")`,
    );

    await queryRunner.query(`
      ALTER TABLE "subprofile_followers" ADD CONSTRAINT "FK_subprofile_followers_subprofile_id"
        FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "subprofile_followers" ADD CONSTRAINT "FK_subprofile_followers_follower_id"
        FOREIGN KEY ("follower_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subprofile_followers" DROP CONSTRAINT "FK_subprofile_followers_follower_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subprofile_followers" DROP CONSTRAINT "FK_subprofile_followers_subprofile_id"`,
    );

    await queryRunner.query(
      `DROP INDEX "IDX_subprofile_followers_follower_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_subprofile_followers_subprofile_id"`,
    );

    await queryRunner.query(`DROP TABLE "subprofile_followers"`);
  }
}
