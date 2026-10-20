// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio listening: "Play without gaps" on a release. When set, the player
 * runs consecutive playable tracks of the release straight into each other
 * and crossfades everywhere else; each stream response names the track it
 * follows gaplessly (`findGaplessAfterTrackId` in
 * `src/studio/studio-gapless.ts`). Every existing release keeps the
 * crossfade through the false default.
 */
export class AddStudioReleaseIsGapless1836900000000 implements MigrationInterface {
  name = 'AddStudioReleaseIsGapless1836900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "studio_releases" ADD "is_gapless" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "studio_releases" DROP COLUMN "is_gapless"`,
    );
  }
}
