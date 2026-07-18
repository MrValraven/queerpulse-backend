import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes "Request an invite" an actually reachable, public, email-based flow.
 *
 * ---------------------------------------------------------------------------
 * The bug this fixes
 * ---------------------------------------------------------------------------
 * `join_requests` was keyed to a `user_id`, and `POST /join-requests` required
 * a JWT plus `users.status = 'pending'`. But no pending user can exist:
 * `AuthService.validateOrCreateGoogleUser` rejects a new Google account that
 * arrives without an invite (`SignupRejectedError('invite_required')`) and
 * creates invited accounts directly as `'active'`. So the only route into the
 * pending state was `src/database/seed.ts`, and the public "Request an invite"
 * page could only ever 401. On top of that the applicant's EMAIL was never
 * stored — the table held `user_id` + `message` — so an admin who somehow saw a
 * request had no way to contact the person.
 *
 * The intended model has no "pending member" state at all: a stranger requests
 * an invite, it lands in the admin queue, an admin approves, and the approval
 * mints an invite bound to the applicant's email. You are either not a member,
 * or an active one. A join request therefore describes a PERSON WHO HAS NO
 * ACCOUNT, and must carry its own identity columns instead of a FK to `users`.
 *
 * ---------------------------------------------------------------------------
 * DATA DECISION: existing rows are DELETED, not backfilled
 * ---------------------------------------------------------------------------
 * `email` and `name` are NOT NULL — they are the entire point of the new shape;
 * a request an admin cannot answer is not worth keeping. There is no sane
 * backfill for a row keyed to a user: copying `users.email` would manufacture a
 * request "from" an address that never submitted one through this flow, and a
 * placeholder like `unknown@invalid` produces rows that look actionable in the
 * admin queue but dead-end when the admin tries to approve (the approval mints
 * an invite BOUND to that email — a placeholder would mint an unredeemable
 * invite).
 *
 * This is safe because the set is empty in practice, which was verified rather
 * than assumed:
 *   - `POST /join-requests` is unreachable, per the analysis above — its
 *     `status === Pending` precondition can never hold for a real account.
 *   - `src/database/seed.ts` creates exactly one pending USER (`seed-pending` /
 *     `sam-pending`) and inserts NO `join_requests` rows. Its `pendingJoinRequest`
 *     seed field targets `community_join_requests` — a different table, owned by
 *     `AddCommunities1782693200000` and untouched here.
 * So the realistic worst case is deleting rows that were hand-inserted into a
 * developer's local database.
 *
 * ---------------------------------------------------------------------------
 * The uniqueness index
 * ---------------------------------------------------------------------------
 * `UQ_join_requests_pending_user` (created by
 * `AddJoinRequestPendingUnique1782692800000` — the name is taken from that
 * migration, not guessed) enforced "at most one OPEN request per user". Its
 * replacement enforces the same invariant on the new key: at most one open
 * request per email, case-insensitively, so `Ana@x.com` cannot queue a second
 * request behind `ana@x.com`. Partial on `status = 'pending'` exactly as before,
 * so a declined applicant may re-apply, while a concurrent double-submit still
 * loses with a 23505 that `JoinRequestsService.submit` maps to a 409.
 */
export class PublicJoinRequests1782800730000 implements MigrationInterface {
  name = 'PublicJoinRequests1782800730000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // See the DATA DECISION block above. Runs first so the NOT NULL columns
    // below can be added without a default and without a backfill step.
    await queryRunner.query(`DELETE FROM "join_requests"`);

    // Drop the user-keyed uniqueness before the column it indexes.
    await queryRunner.query(`DROP INDEX "UQ_join_requests_pending_user"`);
    await queryRunner.query(
      `ALTER TABLE "join_requests" DROP CONSTRAINT "FK_join_requests_user_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_join_requests_user_id"`);
    await queryRunner.query(
      `ALTER TABLE "join_requests" DROP COLUMN "user_id"`,
    );

    // Applicant identity. `name`/`email` are NOT NULL: the queue is useless
    // without a person and a way to reach them. `city` is optional context.
    await queryRunner.query(
      `ALTER TABLE "join_requests" ADD "name" character varying NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "join_requests" ADD "email" character varying NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "join_requests" ADD "city" character varying`,
    );
    // The 18+ self-attestation is captured at request time, mirroring
    // `users.age_attested_at` / `users.terms_version` from
    // `AddAgeAttestation1782800690000`. NOT NULL here (unlike on `users`, where
    // it is nullable only because accounts predate that gate): every row in this
    // table is created by the new endpoint, which requires the attestation.
    await queryRunner.query(
      `ALTER TABLE "join_requests" ADD "age_attested_at" TIMESTAMP WITH TIME ZONE NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "join_requests" ADD "terms_version" character varying(32) NOT NULL`,
    );

    // The invite minted when the request is approved. Nullable: null for
    // pending and declined rows. ON DELETE SET NULL rather than CASCADE — an
    // invite being purged must not erase the audit trail of the approval.
    await queryRunner.query(`ALTER TABLE "join_requests" ADD "invite_id" uuid`);
    await queryRunner.query(
      `CREATE INDEX "IDX_join_requests_invite_id" ON "join_requests" ("invite_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "join_requests" ADD CONSTRAINT "FK_join_requests_invite_id"
        FOREIGN KEY ("invite_id") REFERENCES "invites"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // One OPEN request per email, case-insensitive.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_join_requests_pending_email" ` +
        `ON "join_requests" (lower("email")) WHERE "status" = 'pending'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Symmetric to up(): rows created under the public flow describe people who
    // have no `users` row, so there is no id to put in the restored NOT NULL
    // `user_id`. Reverting drops them for the same reason up() drops the old
    // ones — the target shape cannot represent them.
    await queryRunner.query(`DELETE FROM "join_requests"`);

    await queryRunner.query(`DROP INDEX "UQ_join_requests_pending_email"`);
    await queryRunner.query(
      `ALTER TABLE "join_requests" DROP CONSTRAINT "FK_join_requests_invite_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_join_requests_invite_id"`);
    await queryRunner.query(
      `ALTER TABLE "join_requests" DROP COLUMN "invite_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "join_requests" DROP COLUMN "terms_version"`,
    );
    await queryRunner.query(
      `ALTER TABLE "join_requests" DROP COLUMN "age_attested_at"`,
    );
    await queryRunner.query(`ALTER TABLE "join_requests" DROP COLUMN "city"`);
    await queryRunner.query(`ALTER TABLE "join_requests" DROP COLUMN "email"`);
    await queryRunner.query(`ALTER TABLE "join_requests" DROP COLUMN "name"`);

    await queryRunner.query(
      `ALTER TABLE "join_requests" ADD "user_id" uuid NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_join_requests_user_id" ON "join_requests" ("user_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "join_requests" ADD CONSTRAINT "FK_join_requests_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_join_requests_pending_user" ` +
        `ON "join_requests" ("user_id") WHERE "status" = 'pending'`,
    );
  }
}
