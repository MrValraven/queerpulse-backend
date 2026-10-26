// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

// One row per address shared by more than one account once letter case is
// ignored. Only the user ids reach the error message; the address stays out.
interface DuplicateAddressRow {
  address_key: string;
  user_ids: string;
  accounts: number;
}

/**
 * Adds sign-in with a 6-digit email code.
 *
 * `email_sign_in_challenges` holds one row per emailed code: the purpose
 * (`sign_in` or `reauth`), the normalized address, the hashed requester, the
 * try counter and the expiry, consumed and superseded stamps. The code itself
 * is stored only as an HMAC-SHA256 digest bound to the row id. Rows are purged
 * 24 hours after expiry by `AuthMaintenanceService`.
 *
 * `users.google_id` becomes nullable, because an account created with an email
 * code has no Google identity until Google sign-in attaches one. A functional
 * unique index `UQ_users_email_lower` on `lower(email)` backs the
 * case-insensitive address lookup.
 *
 * Before deploying, the maintainer should run this query by hand:
 *
 *   SELECT lower("email") AS "address_key", string_agg("id"::text, ', ') AS "user_ids", count(*)::int AS "accounts"
 *   FROM "users" GROUP BY lower("email") HAVING count(*) > 1
 *
 * `ensure-database-schema.ts` applies pending migrations at boot, so a
 * duplicate address would stop the deploy at step 1 of `up`. Any row it returns
 * has to be merged or fixed first.
 *
 * Runs in a transaction: the duplicate check and the unique index land
 * together or not at all. The index is a plain build inside the transaction
 * because `users` is small.
 */
export class AddEmailCodeSignIn1837500000000 implements MigrationInterface {
  name = 'AddEmailCodeSignIn1837500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const duplicates = (await queryRunner.query(
      `SELECT lower("email") AS "address_key", string_agg("id"::text, ', ') AS "user_ids", count(*)::int AS "accounts"
       FROM "users" GROUP BY lower("email") HAVING count(*) > 1`,
    )) as DuplicateAddressRow[];
    if (duplicates.length > 0) {
      throw new Error(
        'Cannot add the case-insensitive email index: these accounts share an address that differs only in letter case. Merge or fix them first. User ids per address: ' +
          duplicates.map((row) => '[' + row.user_ids + ']').join(' '),
      );
    }

    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "google_id" DROP NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_users_email_lower" ON "users" (lower("email"))`,
    );

    await queryRunner.query(
      `CREATE TYPE "email_sign_in_challenge_purpose_enum" AS ENUM ('sign_in', 'reauth')`,
    );
    await queryRunner.query(
      `CREATE TABLE "email_sign_in_challenges" (
        "id" uuid NOT NULL,
        "purpose" "email_sign_in_challenge_purpose_enum" NOT NULL,
        "email" character varying(254) NOT NULL,
        "user_id" uuid,
        "requester_hash" character varying(64) NOT NULL,
        "code_hash" character varying(64) NOT NULL,
        "failed_attempts" integer NOT NULL DEFAULT 0,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "consumed_at" TIMESTAMP WITH TIME ZONE,
        "superseded_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_sign_in_challenges" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_email_sign_in_challenges_failed_attempts" CHECK ("failed_attempts" >= 0),
        CONSTRAINT "FK_email_sign_in_challenges_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
    );

    // Per-address caps.
    await queryRunner.query(
      `CREATE INDEX "IDX_email_sign_in_challenges_email_created_at" ON "email_sign_in_challenges" ("email", "created_at")`,
    );
    // Per-requester limits and supersede.
    await queryRunner.query(
      `CREATE INDEX "IDX_email_sign_in_challenges_requester" ON "email_sign_in_challenges" ("requester_hash", "email", "purpose", "created_at")`,
    );
    // Purge.
    await queryRunner.query(
      `CREATE INDEX "IDX_email_sign_in_challenges_expires_at" ON "email_sign_in_challenges" ("expires_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "email_sign_in_challenges"`);
    await queryRunner.query(`DROP TYPE "email_sign_in_challenge_purpose_enum"`);
    await queryRunner.query(`DROP INDEX "UQ_users_email_lower"`);

    const rows = (await queryRunner.query(
      `SELECT count(*)::int AS "n" FROM "users" WHERE "google_id" IS NULL`,
    )) as Array<{ n: number }>;
    const nullCount = rows[0]?.n ?? 0;
    if (nullCount > 0) {
      throw new Error(
        'Cannot restore NOT NULL on users.google_id: ' +
          nullCount +
          ' account(s) sign in with an email code only.',
      );
    }
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "google_id" SET NOT NULL`,
    );
  }
}
