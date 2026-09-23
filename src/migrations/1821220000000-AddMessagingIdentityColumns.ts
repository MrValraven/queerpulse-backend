import { MigrationInterface, QueryRunner } from 'typeorm';

// DO NOT RUN: authored for review only; the maintainer runs migrations.
/**
 * Adds the sender-identity axis to messaging, nullable, and backfills it to
 * each row's own profile identity so existing threads describe themselves
 * correctly. A second migration then tightens the constraints, which keeps
 * the write and the constraint change in separate transactions.
 */
export class AddMessagingIdentityColumns1821220000000 implements MigrationInterface {
  name = 'AddMessagingIdentityColumns1821220000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversation_participants" ADD COLUMN "identity_id" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "messages" ADD COLUMN "sender_identity_id" uuid
    `);

    await queryRunner.query(`
      UPDATE "conversation_participants" AS "participant"
      SET "identity_id" = "identity"."id"
      FROM "identities" AS "identity"
      WHERE "identity"."user_id" = "participant"."user_id"
        AND "identity"."kind" = 'profile'
    `);
    await queryRunner.query(`
      UPDATE "messages" AS "message"
      SET "sender_identity_id" = "identity"."id"
      FROM "identities" AS "identity"
      WHERE "identity"."user_id" = "message"."sender_id"
        AND "identity"."kind" = 'profile'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "messages" DROP COLUMN "sender_identity_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_participants" DROP COLUMN "identity_id"`,
    );
  }
}
