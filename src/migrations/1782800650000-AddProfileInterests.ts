import { MigrationInterface, QueryRunner } from 'typeorm';

// Private Settings → Interests preferences (identities + "what are you looking
// for"). Stored on the profile as text arrays like `open_to`/`tags`, but only
// ever returned to the owner. See docs interests-persistence-design.
export class AddProfileInterests1782800650000 implements MigrationInterface {
  name = 'AddProfileInterests1782800650000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "profiles" ADD "identities" text array NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "profiles" ADD "looking_for" text array NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "profiles" DROP COLUMN "looking_for"`);
    await queryRunner.query(`ALTER TABLE "profiles" DROP COLUMN "identities"`);
  }
}
