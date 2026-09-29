// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `legal_request_amendments`: the field-level history of edits to the legal
 * register (ENG-487).
 *
 * `legal_requests` stamps who recorded a demand and who voided it, and an edit
 * in between overwrote the row in place with no author and no record of the
 * previous values. Every PATCH that changes a stored value now writes one row
 * here: the acting admin, a snapshot of their display name, and
 * `{ [field]: { from, to } }` for exactly the fields that moved.
 *
 * FK behaviour. `legal_request_id` cascades: the register has no delete path,
 * so the cascade only matters when a maintainer clears data by hand, and a
 * history with no record behind it is noise. `actor_user_id` is nullable and
 * `ON DELETE SET NULL`, the actor-FK convention `legal_requests` follows, so
 * the account-erasure sweep is never blocked by this history; `actor_name`
 * keeps the row readable once the id is gone.
 *
 * TRANSACTIONAL, and safely so: a new table created empty, so both indexes
 * build in the same transaction with no `CONCURRENTLY`.
 */
export class CreateLegalRequestAmendments1827010000000 implements MigrationInterface {
  name = 'CreateLegalRequestAmendments1827010000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "legal_request_amendments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "legal_request_id" uuid NOT NULL,
        "actor_user_id" uuid,
        "actor_name" character varying(200),
        "changes" jsonb NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_legal_request_amendments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_legal_request_amendments_legal_request"
          FOREIGN KEY ("legal_request_id")
          REFERENCES "legal_requests"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_legal_request_amendments_actor"
          FOREIGN KEY ("actor_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    // The history pane reads one record's amendments, newest first. Its
    // leading column also serves the cascade's lookups, so the FK needs no
    // index of its own.
    await queryRunner.query(`
      CREATE INDEX "IDX_legal_request_amendments_request_created"
        ON "legal_request_amendments" ("legal_request_id", "created_at")
    `);
    // The account-erasure sweep nulls this column on every row an erased
    // admin wrote; indexed so that lookup avoids a sequential scan (ENG-32,
    // the `1796310000000-AddTrustSafetyErasureForeignKeyIndexes` convention).
    // Partial, since a null actor is never looked up.
    await queryRunner.query(`
      CREATE INDEX "IDX_legal_request_amendments_actor_user_id"
        ON "legal_request_amendments" ("actor_user_id")
        WHERE "actor_user_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "legal_request_amendments"`);
  }
}
