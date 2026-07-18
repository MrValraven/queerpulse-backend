import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Schema support for real GDPR erasure (`AccountDeletionProcessorService`).
 *
 * Four things the erasure sweep needs that the schema did not provide:
 *
 * 1. **`deletion_request.processed_at`** — when the sweep actually erased the
 *    account, as distinct from `scheduled_for` (when it became due). Gives the
 *    sweep an idempotency/observability marker separate from `status`.
 *
 * 2. **`deletion_request` loses its `users` FK.** It was `ON DELETE CASCADE`,
 *    which means deleting the `users` row would take the deletion request with
 *    it — the sweep could never stamp `status = 'erased'`, and we would keep no
 *    record that the erasure happened at all. Dropping the FK lets the request
 *    row survive as the erasure ledger. Its `user_id` is then a dangling uuid
 *    that no longer identifies anybody, which is exactly what we want to retain.
 *
 * 3. **`reports.reporter_id` / `mod_audit_logs.actor_id` become nullable and
 *    `ON DELETE SET NULL`** (both were `NOT NULL` + `ON DELETE CASCADE`).
 *    Moderation history must outlive the member: abuse reports an erased member
 *    filed *against other people* have to survive, or erasing an account becomes
 *    a way to wipe the evidence trail against everyone you reported. The sweep
 *    NULLs both columns explicitly before deleting the user; the `SET NULL` rule
 *    is the belt-and-braces guarantee if anything ever deletes a user by another
 *    path.
 *
 * 4. **`email_suppression`** — the "we won't accidentally re-create your
 *    account" list the delete-account UI promises. Deliberately has **no FK to
 *    `users`**: its whole job is to outlive the user row. It stores a sha-256
 *    hash of the normalized email, never the address itself — see the entity
 *    (`src/account/entities/email-suppression.entity.ts`) for that rationale.
 */
export class AddDeletionErasureSupport1782800700000 implements MigrationInterface {
  name = 'AddDeletionErasureSupport1782800700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- deletion_request: erasure ledger -------------------------------------
    await queryRunner.query(
      `ALTER TABLE "deletion_request" ADD COLUMN "processed_at" TIMESTAMP WITH TIME ZONE`,
    );
    // See (2) above: the row has to survive the user it refers to.
    await queryRunner.query(
      `ALTER TABLE "deletion_request" DROP CONSTRAINT "FK_deletion_request_user_id"`,
    );

    // --- reports.reporter_id: preserve reports filed by an erased member ------
    await queryRunner.query(
      `ALTER TABLE "reports" DROP CONSTRAINT "FK_reports_reporter_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reports" ALTER COLUMN "reporter_id" DROP NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "reports" ADD CONSTRAINT "FK_reports_reporter_id"
        FOREIGN KEY ("reporter_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // --- mod_audit_logs.actor_id: preserve the moderator action trail --------
    await queryRunner.query(
      `ALTER TABLE "mod_audit_logs" DROP CONSTRAINT "FK_mod_audit_logs_actor_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mod_audit_logs" ALTER COLUMN "actor_id" DROP NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "mod_audit_logs" ADD CONSTRAINT "FK_mod_audit_logs_actor_id"
        FOREIGN KEY ("actor_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // --- email_suppression: survives erasure, so no FK to "users" -------------
    await queryRunner.query(`
      CREATE TABLE "email_suppression" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "email_hash" character varying NOT NULL,
        "reason" character varying NOT NULL DEFAULT 'account_deleted',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_suppression" PRIMARY KEY ("id")
      )
    `);
    // Lookup is a single equality probe on every new-account sign-in, so the
    // unique index doubles as the read path and the "suppress once" guarantee.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_email_suppression_email_hash" ON "email_suppression" ("email_hash")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "email_suppression"`);

    // Reverting the nullability is only possible while no row has actually been
    // NULLed — i.e. before the first erasure runs. Once a member has been
    // erased, `SET NOT NULL` will (correctly) fail rather than silently
    // resurrect a `reporter_id`/`actor_id` that no longer exists. Re-pointing
    // those rows is a data decision, not something a `down()` should guess at.
    await queryRunner.query(
      `ALTER TABLE "mod_audit_logs" DROP CONSTRAINT "FK_mod_audit_logs_actor_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mod_audit_logs" ALTER COLUMN "actor_id" SET NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "mod_audit_logs" ADD CONSTRAINT "FK_mod_audit_logs_actor_id"
        FOREIGN KEY ("actor_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(
      `ALTER TABLE "reports" DROP CONSTRAINT "FK_reports_reporter_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reports" ALTER COLUMN "reporter_id" SET NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "reports" ADD CONSTRAINT "FK_reports_reporter_id"
        FOREIGN KEY ("reporter_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    // Likewise: re-adding this FK fails if any `deletion_request` row now points
    // at an erased (deleted) user — which is the normal state after a sweep.
    await queryRunner.query(`
      ALTER TABLE "deletion_request" ADD CONSTRAINT "FK_deletion_request_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(
      `ALTER TABLE "deletion_request" DROP COLUMN "processed_at"`,
    );
  }
}
