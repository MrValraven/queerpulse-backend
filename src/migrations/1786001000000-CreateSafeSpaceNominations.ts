import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `safe_space_nominations` — one row per member suggesting a place be
 * reviewed for the safe-space badge. Backs `POST /safe-space-nominations`
 * (member intake) and `GET /admin/safe-space-nominations` (moderation queue).
 *
 * `nominator_id` FK cascades on user delete (a nomination is meaningless once
 * its author is erased). `status` is a plain varchar defaulting to `pending`
 * (extensible without a migration); indexed for the queue's status filter.
 * `IDX_safe_space_nominations_nominator_id` supports the per-member lookup and
 * the FK cascade.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class CreateSafeSpaceNominations1786001000000
  implements MigrationInterface
{
  name = 'CreateSafeSpaceNominations1786001000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "safe_space_nominations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "nominator_id" uuid NOT NULL,
        "place_name" character varying(200) NOT NULL,
        "address" character varying(300),
        "place_type" character varying(100),
        "listing_ref" character varying(200),
        "reason" text,
        "status" character varying(20) NOT NULL DEFAULT 'pending',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_safe_space_nominations" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_safe_space_nominations_nominator_id" ON "safe_space_nominations" ("nominator_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_safe_space_nominations_status" ON "safe_space_nominations" ("status")`,
    );
    await queryRunner.query(
      `ALTER TABLE "safe_space_nominations" ADD CONSTRAINT "FK_safe_space_nominations_nominator_id" FOREIGN KEY ("nominator_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "safe_space_nominations" DROP CONSTRAINT "FK_safe_space_nominations_nominator_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_safe_space_nominations_status"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_safe_space_nominations_nominator_id"`,
    );
    await queryRunner.query(`DROP TABLE "safe_space_nominations"`);
  }
}
