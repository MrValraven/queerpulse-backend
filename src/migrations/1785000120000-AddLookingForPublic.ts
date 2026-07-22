// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `looking_for_public` (boolean, default false, not null) to profiles.
 * Default false preserves the current owner-private behaviour for every
 * existing row — a member's `lookingFor` stays hidden until they opt in.
 */
export class AddLookingForPublic1785000120000 implements MigrationInterface {
  name = 'AddLookingForPublic1785000120000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "profiles" ADD "looking_for_public" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "profiles" DROP COLUMN "looking_for_public"`,
    );
  }
}
