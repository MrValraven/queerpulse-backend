import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `submitter_id` to `magazine_pitch` (Magazine Desk Phase 6, Task 1) so
 * a writer's "your pitches" view can be scoped to `submitterId ===
 * user.id`, mirroring `magazine_piece.writer_id`. Nullable + no `FOREIGN
 * KEY` (repo idiom — see `AddMagazinePieces`): pitches can still arrive from
 * outside the platform with no linked writer account.
 */
export class AddPitchSubmitter1786800000000 implements MigrationInterface {
  name = 'AddPitchSubmitter1786800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "magazine_pitch"
        ADD COLUMN "submitter_id" uuid
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_pitch_submitter" ON "magazine_pitch" ("submitter_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_magazine_pitch_submitter"`);
    await queryRunner.query(`
      ALTER TABLE "magazine_pitch"
        DROP COLUMN "submitter_id"
    `);
  }
}
