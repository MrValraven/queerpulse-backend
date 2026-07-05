import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJoinRequestPendingUnique1782692800000
  implements MigrationInterface
{
  name = 'AddJoinRequestPendingUnique1782692800000';

  // Enforce at most one *pending* join request per user at the database level.
  // A partial unique index ignores approved/declined rows, so a user can still
  // re-apply after a decline while a concurrent double-submit is rejected with
  // a 23505 the service maps to 409.
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_join_requests_pending_user" ` +
        `ON "join_requests" ("user_id") WHERE "status" = 'pending'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_join_requests_pending_user"`);
  }
}
