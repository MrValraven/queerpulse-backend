// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The profile Now card's own schema: the status history the card's
 * "Before this" disclosure reads, and the timestamp it dates the current
 * status by.
 *
 * NO BACKFILL of `now_updated_at`, and this is deliberate. Every existing
 * profile would have to be dated from something that is not when the status
 * changed (`updated_at` moves on any edit, `created_at` predates most
 * statuses), and a card that says "Updated 8 months ago" about a status
 * written last week is worse than a card that says nothing. NULL reads as
 * "unknown" and the card omits the line.
 *
 * `profile_now_history.user_id` carries a `FOREIGN KEY ... ON DELETE
 * CASCADE` to `users(id)`, matching `profile_last_active`
 * (`1794760000000-CreateProfileLastActive.ts`): a member's own retired
 * statuses are not a record worth keeping once the account that wrote them
 * is erased. `IDX_profile_now_history_user_ended` is a plain (non-
 * concurrent) index because the table is brand new and empty at the moment
 * this migration creates it, same reasoning as `profile_last_active`'s own
 * index.
 *
 * TRANSACTIONAL, unlike its companion `1817140000000
 * -AddConnectionsAddresseeCreatedIndex.ts`. Every object here (the column,
 * the table, its index, its FK) is either brand new or an ALTER on
 * `profiles` cheap enough to take the usual lock briefly, so the column add,
 * the table, the index and the FK land together or not at all, with no
 * `CONCURRENTLY` involved and no reason to opt out of the transaction. The
 * `connections` index that the plan originally drafted alongside this one
 * was split into its own migration precisely because it needs
 * `CONCURRENTLY` (an already-production table) and `CONCURRENTLY` cannot
 * share a transaction with anything else: mixing it into this file would put
 * a possibly-interrupted concurrent index build in the same non-
 * transactional unit as this table's DDL, so a failed index build could
 * leave the column/table/index/FK committed with no ledger row, and the next
 * `migration:run` would die on "already exists", the ledger-mismatch
 * surgery CLAUDE.md warns against. Keeping this file transactional avoids
 * that failure mode entirely.
 *
 * No `IF [NOT] EXISTS` guards anywhere in this file: re-runnability comes
 * from the deploy preflight, not from guards that would hide drift (see
 * CLAUDE.md).
 */
export class AddProfileNowHistory1817130000000 implements MigrationInterface {
  name = 'AddProfileNowHistory1817130000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "profiles" ADD COLUMN "now_updated_at" TIMESTAMP WITH TIME ZONE`,
    );

    await queryRunner.query(`
      CREATE TABLE "profile_now_history" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "text" text NOT NULL,
        "started_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "ended_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_profile_now_history" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_profile_now_history_user_ended"
        ON "profile_now_history" ("user_id", "ended_at")
    `);
    await queryRunner.query(`
      ALTER TABLE "profile_now_history"
        ADD CONSTRAINT "FK_profile_now_history_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "profile_now_history" DROP CONSTRAINT "FK_profile_now_history_user_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_profile_now_history_user_ended"`);
    await queryRunner.query(`DROP TABLE "profile_now_history"`);

    await queryRunner.query(
      `ALTER TABLE "profiles" DROP COLUMN "now_updated_at"`,
    );
  }
}
