import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Denormalizes `profiles.vouch_count` — the number of ACTIVE (non-withdrawn)
 * vouches a member has received — off `vouches` (Performance audit finding
 * B3, `references/database-and-indexing.md`).
 *
 * `ProfilesService.searchMembers`'s `MostVouched` sort previously ordered by
 * a correlated `(SELECT COUNT(*) FROM vouches WHERE vouchee_id = p.user_id
 * AND withdrawn_at IS NULL)` scalar subquery, re-evaluated for every
 * candidate profile row on every page of every request — O(members) count
 * queries per search. `vouch_count` lets that sort read a plain indexed
 * integer column instead.
 *
 * `VouchService` keeps this column in sync going forward with an atomic
 * `UPDATE profiles SET vouch_count = vouch_count ± 1` inside the same
 * transaction as each vouch create/reactivate/withdraw
 * (`createVouch`/`createVouchInTransaction`/`withdrawVouch`) — never a
 * read-then-write, so concurrent vouches on the same member can't clobber
 * each other's increment.
 *
 * `down()` drops the column; nothing else reads it.
 */
export class AddProfileVouchCount1787600100000 implements MigrationInterface {
  name = 'AddProfileVouchCount1787600100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "profiles" ADD COLUMN "vouch_count" integer NOT NULL DEFAULT 0`,
    );

    // Backfill from the current, real vouch counts — every existing row
    // otherwise starts at the column default of 0, which is wrong for any
    // member who already has active vouches at the time this migration runs.
    await queryRunner.query(
      `UPDATE "profiles" SET "vouch_count" = (
         SELECT COUNT(*) FROM "vouches"
         WHERE "vouches"."vouchee_id" = "profiles"."user_id"
           AND "vouches"."withdrawn_at" IS NULL
       )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "profiles" DROP COLUMN "vouch_count"`);
  }
}
