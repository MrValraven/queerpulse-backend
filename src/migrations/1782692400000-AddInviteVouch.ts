import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInviteVouch1782692400000 implements MigrationInterface {
  name = 'AddInviteVouch1782692400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "invites" ADD "vouch" character varying(280)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "invites" DROP COLUMN "vouch"`);
  }
}
