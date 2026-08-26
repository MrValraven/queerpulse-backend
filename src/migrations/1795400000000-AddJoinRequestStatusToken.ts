import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `join_requests.status_token_hash` (ACQ-01) — the opaque credential
 * behind the applicant's own status page, `GET /join-requests/status?token=…`.
 *
 * WHY A TOKEN AT ALL. After submitting, an applicant previously got a static
 * "what happens next" screen and then nothing, forever: no way to learn they
 * were approved, declined or waitlisted, and no way to recover the invite code
 * an approval minted. The platform delivers no email and never will, so the
 * ONLY moment the applicant can be handed anything is the 201 response to
 * their own submission. This column is what that handed-out token resolves
 * against.
 *
 * WHY HASHED. The plaintext token is a bearer credential on an
 * unauthenticated read, exactly like a refresh token (`AuthService.hashToken`)
 * or an account-deletion token. Storing the sha256 hex instead of the token
 * means a leaked dump cannot be replayed against the public lookup: an
 * attacker holding every row still holds no usable token. 64 characters is the
 * exact width of sha256 in hex.
 *
 * WHY NULLABLE. Every row written before this migration predates the token and
 * keeps `NULL`; those applicants have no status page, which is the same
 * position they were already in. Postgres does not treat NULLs as equal in a
 * unique index, so the legacy rows never collide with one another.
 *
 * The unique index is what makes the lookup safe: one token resolves to at
 * most one request, so the read path never has to disambiguate. It is created
 * non-concurrently and this migration adds no enum value, so it stays fully
 * transactional.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddJoinRequestStatusToken1795400000000 implements MigrationInterface {
  name = 'AddJoinRequestStatusToken1795400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "join_requests" ADD "status_token_hash" character varying(64)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_join_requests_status_token_hash" ` +
        `ON "join_requests" ("status_token_hash")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_join_requests_status_token_hash"`);
    await queryRunner.query(
      `ALTER TABLE "join_requests" DROP COLUMN "status_token_hash"`,
    );
  }
}
