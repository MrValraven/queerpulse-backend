import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * At most ONE open (`grace`/`processing`) deletion request per member, enforced
 * by the database.
 *
 * `AccountService.requestDeletion` used to do its duplicate check outside the
 * transaction with no backstop here, so two overlapping
 * `POST /account/deletion-request` calls (double-submit, a retry after a
 * timeout, two tabs) both passed the pre-check and both inserted a `grace` row.
 * `cancelDeletionRequest` then cancelled exactly one of them, and the erasure
 * sweep picked the survivor up 30 days later and hard-deleted an account whose
 * owner had cancelled in good faith. This index is the half of that fix the
 * application cannot provide: the service's in-transaction pre-check narrows
 * the race, only a unique index closes it (23505 -> the existing 409).
 *
 * `processing` is included in the predicate so an erasure already in flight
 * also blocks a fresh request.
 *
 * The backfill below collapses any duplicate open rows that already exist,
 * since the index cannot be built while one is present. It keeps the row the
 * erasure sweep would actually act on — a `processing` row first, otherwise the
 * newest `grace` row — and cancels the rest, which is a no-op on a healthy
 * database.
 */
export class AddDeletionRequestOpenUniqueIndex1793500200000 implements MigrationInterface {
  name = 'AddDeletionRequestOpenUniqueIndex1793500200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "deletion_request" AS d
      SET "status" = 'cancelled', "updated_at" = now()
      WHERE d."status" IN ('grace', 'processing')
        AND d."id" <> (
          SELECT k."id"
          FROM "deletion_request" AS k
          WHERE k."user_id" = d."user_id"
            AND k."status" IN ('grace', 'processing')
          ORDER BY (k."status" = 'processing') DESC,
                   k."created_at" DESC,
                   k."id" DESC
          LIMIT 1
        )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_deletion_request_open_user" ` +
        `ON "deletion_request" ("user_id") ` +
        `WHERE "status" IN ('grace', 'processing')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The backfill is not reversible: a row cancelled above cannot be told
    // apart from one the member cancelled themselves. Dropping the index is
    // the whole of the down migration.
    await queryRunner.query(`DROP INDEX "UQ_deletion_request_open_user"`);
  }
}
