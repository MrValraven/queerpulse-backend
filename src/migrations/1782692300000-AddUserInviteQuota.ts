import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserInviteQuota1782692300000 implements MigrationInterface {
  name = 'AddUserInviteQuota1782692300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "invite_monthly_quota" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "invite_monthly_quota"`,
    );
  }
}
