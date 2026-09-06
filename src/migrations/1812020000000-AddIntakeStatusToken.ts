// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `intake_submissions.status_token_hash` (PRD-261) — the opaque
 * credential behind a concern submitter's own status page,
 * `GET /intakes/concerns/status?token=…`.
 *
 * WHY A TOKEN AT ALL. The public "Submit a concern" form told the submitter
 * they would get a confirmation and an update when the matter was resolved.
 * For a SIGNED-IN member that was half true: `IntakesService.notifySubmitter`
 * writes a `ConcernUpdate` bell when the concern reaches an outcome. For an
 * anonymous submitter it was true of nothing at all. The row carried a typed
 * email address, the platform delivers no email and never will, so the outcome
 * was recorded where the one person waiting for it could never see it. Someone
 * reporting harm, or appealing a decision that went against them, read the
 * silence as the report having been dropped.
 *
 * This column is what the handed-out token resolves against. As with
 * `join_requests.status_token_hash` (`AddJoinRequestStatusToken`), the only
 * moment the submitter can be handed anything is the 201 response to their own
 * submission, so that is where the plaintext is minted and shown.
 *
 * WHY HASHED. The plaintext is a bearer credential on an unauthenticated read,
 * exactly like a refresh token (`AuthService.hashToken`) or a join-request
 * status token. Storing the sha256 hex means a leaked dump hands an attacker
 * no usable lookup token — which matters more here than anywhere else on the
 * platform, because the row behind the token is a confidential report about a
 * named person. 64 characters is the exact width of sha256 in hex.
 *
 * WHY NULLABLE. Every row written before this migration predates the token and
 * keeps `NULL`, and every non-concern intake kind never mints one: those forms
 * have no submitter-facing worklist to look at. Postgres does not treat NULLs
 * as equal in a unique index, so neither the legacy rows nor the eleven other
 * kinds collide with one another.
 *
 * The unique index is what makes the lookup safe: one token resolves to at
 * most one submission, so the read path never disambiguates. Created
 * non-concurrently and no enum value is added, so this stays fully
 * transactional.
 */
export class AddIntakeStatusToken1812020000000 implements MigrationInterface {
  name = 'AddIntakeStatusToken1812020000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "intake_submissions" ADD "status_token_hash" character varying(64)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_intake_submissions_status_token_hash" ` +
        `ON "intake_submissions" ("status_token_hash")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "UQ_intake_submissions_status_token_hash"`,
    );
    await queryRunner.query(
      `ALTER TABLE "intake_submissions" DROP COLUMN "status_token_hash"`,
    );
  }
}
