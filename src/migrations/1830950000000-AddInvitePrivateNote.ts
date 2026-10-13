// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

// The inviter's own label on an invite ("who is this for?"). Seen only by the
// inviter and admins.
export class AddInvitePrivateNote1830950000000 implements MigrationInterface {
  name = 'AddInvitePrivateNote1830950000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "invites" ADD "private_note" character varying(120)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "invites" DROP COLUMN "private_note"`);
  }
}
