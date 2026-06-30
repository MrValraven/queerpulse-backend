import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInviteNote1782692200000 implements MigrationInterface {
  name = 'AddInviteNote1782692200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "invites" ADD "note" character varying(200)`,
    );
    await queryRunner.query(
      `ALTER TABLE "invites" ADD "used_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "invites" DROP COLUMN "used_at"`);
    await queryRunner.query(`ALTER TABLE "invites" DROP COLUMN "note"`);
  }
}
