import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Make the self-referential `replaced_by` foreign key DEFERRABLE INITIALLY
 * DEFERRED.
 *
 * `AuthService.rotateRefreshToken` rotates a token in a SINGLE transaction: it
 * first UPDATEs the old row to set `replaced_by = <newRowId>`, then INSERTs the
 * new row carrying that pre-generated id. That ordering is deliberate (it lets
 * the conditional revoke-claim and the new-row insert share one transaction),
 * but it only works if the FK is checked at COMMIT — by which point both rows
 * exist. The original constraint was NOT DEFERRABLE, so Postgres checked it
 * immediately on the UPDATE, when `<newRowId>` did not yet exist, and EVERY
 * refresh 500'd with `violates foreign key constraint
 * "FK_refresh_tokens_replaced_by"`. With refresh permanently broken, members
 * were silently signed out at each 15-minute access-token expiry.
 *
 * INITIALLY DEFERRED (not just DEFERRABLE) is required: the rotation code does
 * not issue `SET CONSTRAINTS ... DEFERRED`, so the constraint must default to
 * deferred for the check to land at commit.
 */
export class MakeRefreshTokenReplacedByFkDeferrable1782800830000
  implements MigrationInterface
{
  name = 'MakeRefreshTokenReplacedByFkDeferrable1782800830000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP CONSTRAINT "FK_refresh_tokens_replaced_by"`,
    );
    await queryRunner.query(`
      ALTER TABLE "refresh_tokens" ADD CONSTRAINT "FK_refresh_tokens_replaced_by"
        FOREIGN KEY ("replaced_by") REFERENCES "refresh_tokens"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
        DEFERRABLE INITIALLY DEFERRED
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP CONSTRAINT "FK_refresh_tokens_replaced_by"`,
    );
    await queryRunner.query(`
      ALTER TABLE "refresh_tokens" ADD CONSTRAINT "FK_refresh_tokens_replaced_by"
        FOREIGN KEY ("replaced_by") REFERENCES "refresh_tokens"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }
}
