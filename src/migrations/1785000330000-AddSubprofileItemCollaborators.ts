import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Subprofiles Phase 3d: adds `collaborators` (a `tags`-shaped `text[]` of
 * normalized handles) to `subprofile_items`, letting an item credit other
 * members/personas by `@handle`. See
 * `src/subprofiles/entities/subprofile-item.entity.ts`.
 */
export class AddSubprofileItemCollaborators1785000330000 implements MigrationInterface {
  name = 'AddSubprofileItemCollaborators1785000330000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subprofile_items" ADD "collaborators" text array NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subprofile_items" DROP COLUMN "collaborators"`,
    );
  }
}
