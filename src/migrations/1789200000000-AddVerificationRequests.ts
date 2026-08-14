import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `verification_requests` — one row per submitted verification request,
 * the table the review queue reads from. This is the manual
 * submit → review → decision → appeal lifecycle sitting alongside Phase 1's
 * current-level store (`member_verifications`) and audit trail
 * (`verification_events`); see `verification-request-status.ts` for the
 * state machine enforced on top of the `status` column.
 *
 * Reuses the `verification_type_enum` and `member_verification_level_enum`
 * types created by `AddVerificationAudit1789100000000` — do NOT recreate
 * them here.
 */
export class AddVerificationRequests1789200000000 implements MigrationInterface {
  name = 'AddVerificationRequests1789200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "verification_request_status_enum" AS ENUM ('pending', 'in_review', 'approved', 'rejected', 'appealing', 'withdrawn')`,
    );

    await queryRunner.query(`
      CREATE TABLE "verification_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "type" "verification_type_enum" NOT NULL DEFAULT 'identity',
        "requested_level" "member_verification_level_enum" NOT NULL,
        "status" "verification_request_status_enum" NOT NULL DEFAULT 'pending',
        "context" text,
        "evidence_ref" character varying(255),
        "decision_reason" text,
        "reviewed_by_user_id" uuid,
        "signals" jsonb,
        "is_appeal" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_verification_requests" PRIMARY KEY ("id"),
        CONSTRAINT "FK_verification_requests_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_verification_requests_reviewed_by" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    // Queue filters (status + dimension).
    await queryRunner.query(
      `CREATE INDEX "IDX_verification_requests_status_type" ON "verification_requests" ("status", "type")`,
    );
    // Member's own request history.
    await queryRunner.query(
      `CREATE INDEX "IDX_verification_requests_user" ON "verification_requests" ("user_id")`,
    );
    // Partial index backing the nav badge's open-request count — only the
    // rows that are actually "in flight" need to be scanned.
    await queryRunner.query(`
      CREATE INDEX "IDX_verification_requests_open" ON "verification_requests" ("status")
      WHERE "status" IN ('pending', 'in_review', 'appealing')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_verification_requests_open"`);
    await queryRunner.query(`DROP INDEX "IDX_verification_requests_user"`);
    await queryRunner.query(
      `DROP INDEX "IDX_verification_requests_status_type"`,
    );
    await queryRunner.query(`DROP TABLE "verification_requests"`);
    await queryRunner.query(`DROP TYPE "verification_request_status_enum"`);
  }
}
