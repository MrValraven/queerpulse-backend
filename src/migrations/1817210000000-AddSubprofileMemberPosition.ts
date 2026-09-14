// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persona ordering under a member's profile becomes PER-MEMBER. Adds
 * `subprofile_members.position`, the rank of one persona inside ONE member's
 * own list.
 *
 * THE BUG THIS CLOSES. Ordering lived on `subprofiles.position`, a single
 * column on the persona row itself. A persona can be co-owned (see
 * `subprofile_members`, `MAX_SUBPROFILE_CO_OWNERS`), and both co-owners see
 * that same persona nested under their own profile. One column therefore had
 * to serve two different lists at once: a co-owner dragging their personas
 * into the order they wanted silently reshuffled their collaborator's profile
 * as a side effect, with no signal to either of them that it had happened.
 * Ordering is a per-member preference about a member's own page, so it belongs
 * on the membership row rather than on the shared persona.
 *
 * WHY A BACKFILL AND NOT JUST A DEFAULT. Leaving every row at the `0` default
 * would collapse today's visible order into "created oldest first" for every
 * member on the deploy, silently discarding orderings members had already
 * arranged. The backfill reproduces the exact order the two reads
 * (`SubprofilesService.listMine`, `SubprofilePublicReadService.listForProfile`)
 * produce today: `ORDER BY sp.position ASC, sp.created_at ASC`, ranked per
 * `user_id`, so every member's list comes out of this migration looking
 * identical to how it looked going in. `row_number() - 1` makes the sequence
 * zero-based, matching the array index the reorder endpoint writes.
 *
 * `subprofiles.position` is deliberately left in place and left alone. It is
 * frozen history after this: nothing writes it any more (the `position` field
 * comes off `UpdateSubprofileDTO` in the same change, so the reorder endpoint
 * is the single writer of ordering), and the two reads above now sort by the
 * member position. Dropping the old column is a separate migration once the
 * backfill has been observed in production.
 *
 * NO NEW INDEX, deliberately. The column is never a predicate or a sort key at
 * the database level: both reads already fetch a member's rows by
 * `user_id` through the existing `IDX_subprofile_members_user_id`, and the
 * ordering is applied in memory over that result. A member may create at most
 * `MAX_SUBPROFILES` (12) personas and co-owns a handful more at the outside,
 * so that set stays tiny and an index on `position` would earn nothing while
 * costing a write on every reorder.
 *
 * Ordinary transactional migration: the column add and the backfill are plain
 * DDL/DML with no `CONCURRENTLY`, so they belong in one all-or-nothing unit
 * (no `transaction = false`). No `IF NOT EXISTS` guard, which CLAUDE.md
 * forbids because it hides genuine schema drift.
 */
export class AddSubprofileMemberPosition1817210000000 implements MigrationInterface {
  name = 'AddSubprofileMemberPosition1817210000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `NOT NULL DEFAULT 0` so existing rows land on a real value immediately
    // and a member row inserted by an older deploy mid-rollout is still valid.
    // The backfill below then replaces that placeholder with each member's
    // real current order.
    await queryRunner.query(
      `ALTER TABLE "subprofile_members" ` +
        `ADD COLUMN "position" integer NOT NULL DEFAULT 0`,
    );

    // Per-member backfill. Ranked inside each `user_id` partition by exactly
    // the ordering the reads use today (`sp.position ASC, sp.created_at ASC`),
    // so today's visible order is preserved row for row. The join to
    // `subprofiles` is what supplies those two sort keys; the update is keyed
    // on the membership row's own primary key so each row is written once.
    await queryRunner.query(`
      UPDATE "subprofile_members" AS "target"
      SET "position" = "ranked"."member_position"
      FROM (
        SELECT "m"."id" AS "member_id",
               row_number() OVER (
                 PARTITION BY "m"."user_id"
                 ORDER BY "sp"."position" ASC, "sp"."created_at" ASC
               ) - 1 AS "member_position"
        FROM "subprofile_members" "m"
        JOIN "subprofiles" "sp" ON "sp"."id" = "m"."subprofile_id"
      ) AS "ranked"
      WHERE "target"."id" = "ranked"."member_id"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subprofile_members" DROP COLUMN "position"`,
    );
  }
}
