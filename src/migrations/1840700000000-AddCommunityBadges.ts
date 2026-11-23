// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';
import { COMMUNITY_BADGE_STARTER_SEEDS_1840700000000 } from './data/community-badge-starters-1840700000000.seed';

/**
 * Community badges, staff gifts and name flair: every top-level community gets
 * an editable set of automatically awarded badges, staff send gifts with a
 * short note, and members wear one earned badge as flair beside their name.
 * Three new tables (`community_badges`, `community_badge_awards`,
 * `community_gifts`), the `community_badges_rule_type_enum` type, two
 * `community_members` columns (`worn_badge_id` and the events attended tally
 * `events_attended_count`), the four starter badges seeded from the frozen data
 * in `./data/community-badge-starters-1840700000000.seed.ts`, and eight enum
 * labels (two notification types, five governance log actions and the
 * `community_gift` report subject).
 *
 * The default migration transaction stays, as in
 * AddCulturalProduction1840600000000: on Postgres 12+ `ALTER TYPE ... ADD
 * VALUE` may run inside the wrapping transaction as long as no statement in
 * that transaction uses the new label, and nothing here does. The label
 * appends run last.
 *
 * The tally `events_attended_count` is initialised once per roster row from the
 * check-ins the retention job has not erased yet: distinct events of that
 * community the member was checked in at on or after the row's `joined_at`, so
 * a member who left and rejoined starts from the current membership (contract
 * section 12). Check-ins the job already erased are gone and cannot be counted.
 * A check-in recorded after this statement runs and before the new code that
 * increments the tally is live stays out of the tally; that window is the
 * deploy itself, and every later check-in counts.
 *
 * Seeding inserts the four starters for every community with no parent
 * (archived included), each with `backfill_requested_at = now()` and
 * `created_at` staggered by one millisecond in seed order. It inserts no
 * awards: the per-minute backfill job awards qualifying members silently after
 * deploy, so history rings no bell.
 *
 * Indexes and the reads they back:
 * - `IDX_community_badges_community_id_created_at` serves the per-community
 *   badge list in creation order.
 * - `UQ_community_badges_community_name` keeps names unique per community
 *   ignoring case (an expression index, migration only), and
 *   `UQ_community_badges_community_starter_key` keeps each starter once.
 * - `IDX_community_badges_backfill_requested_at` serves the per-minute
 *   backfill job; the partial creator, remover and worn badge indexes back
 *   their `ON DELETE SET NULL` keys.
 * - `UQ_community_badge_awards_badge_user` is the award insert's
 *   `ON CONFLICT DO NOTHING` target, `IDX_community_badge_awards_community_user`
 *   serves the per-member award reads and `IDX_community_badge_awards_user_id`
 *   the account erasure cascade.
 * - `IDX_community_gifts_community_recipient_sent` serves the recent-gift
 *   marks, `IDX_community_gifts_community_sender_sent` the weekly allowance
 *   count, and the recipient and sender indexes the account erasure.
 *
 * The three badge and gift tables are new, so their indexes build empty inside
 * the migration transaction. `IDX_community_members_worn_badge_id` builds on the
 * live `community_members` table, also inside the transaction: the column it
 * covers is added by this migration with every row NULL, so the partial index
 * starts empty. The `ALTER TABLE` statements hold an exclusive lock on
 * `community_members` until commit, so roster writes wait for the tally update
 * and the seeding to finish.
 */
export class AddCommunityBadges1840700000000 implements MigrationInterface {
  name = 'AddCommunityBadges1840700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "community_badges_rule_type_enum" AS ENUM ('tenure_days', 'events_checked_in', 'volunteer_hours', 'posts_and_replies')`,
    );

    await queryRunner.query(
      `CREATE TABLE "community_badges" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "community_id" uuid NOT NULL,
        "starter_key" character varying(32),
        "name" character varying(32) NOT NULL,
        "icon_key" character varying(32) NOT NULL,
        "tint" character varying(16) NOT NULL,
        "rule_type" "community_badges_rule_type_enum" NOT NULL,
        "threshold" integer NOT NULL,
        "is_enabled" boolean NOT NULL DEFAULT true,
        "created_by_id" uuid,
        "backfill_requested_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_community_badges" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_community_badges_threshold" CHECK (("rule_type" = 'tenure_days' AND "threshold" BETWEEN 30 AND 3650) OR ("rule_type" = 'events_checked_in' AND "threshold" BETWEEN 1 AND 500) OR ("rule_type" = 'volunteer_hours' AND "threshold" BETWEEN 1 AND 1000) OR ("rule_type" = 'posts_and_replies' AND "threshold" BETWEEN 1 AND 5000)),
        CONSTRAINT "FK_community_badges_community" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_community_badges_created_by" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_badges_community_id_created_at" ON "community_badges" ("community_id", "created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_community_badges_community_name" ON "community_badges" ("community_id", lower("name"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_community_badges_community_starter_key" ON "community_badges" ("community_id", "starter_key") WHERE "starter_key" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_badges_backfill_requested_at" ON "community_badges" ("backfill_requested_at") WHERE "backfill_requested_at" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_badges_created_by_id" ON "community_badges" ("created_by_id") WHERE "created_by_id" IS NOT NULL`,
    );

    await queryRunner.query(
      `CREATE TABLE "community_badge_awards" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "badge_id" uuid NOT NULL,
        "community_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "awarded_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "is_notified" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_community_badge_awards" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_community_badge_awards_badge_user" UNIQUE ("badge_id", "user_id"),
        CONSTRAINT "FK_community_badge_awards_badge" FOREIGN KEY ("badge_id") REFERENCES "community_badges"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_community_badge_awards_community" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_community_badge_awards_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_badge_awards_community_user" ON "community_badge_awards" ("community_id", "user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_badge_awards_user_id" ON "community_badge_awards" ("user_id")`,
    );

    await queryRunner.query(
      `CREATE TABLE "community_gifts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "community_id" uuid NOT NULL,
        "sender_id" uuid,
        "recipient_id" uuid NOT NULL,
        "gift_key" character varying(32) NOT NULL,
        "note" character varying(140),
        "sent_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "hidden_by_recipient_at" TIMESTAMP WITH TIME ZONE,
        "removed_at" TIMESTAMP WITH TIME ZONE,
        "removed_by_id" uuid,
        CONSTRAINT "PK_community_gifts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_community_gifts_community" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_community_gifts_sender" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_community_gifts_recipient" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_community_gifts_removed_by" FOREIGN KEY ("removed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_gifts_community_recipient_sent" ON "community_gifts" ("community_id", "recipient_id", "sent_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_gifts_community_sender_sent" ON "community_gifts" ("community_id", "sender_id", "sent_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_gifts_recipient_id" ON "community_gifts" ("recipient_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_gifts_sender_id" ON "community_gifts" ("sender_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_gifts_removed_by_id" ON "community_gifts" ("removed_by_id") WHERE "removed_by_id" IS NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "community_members" ADD "worn_badge_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_members" ADD CONSTRAINT "FK_community_members_worn_badge_id" FOREIGN KEY ("worn_badge_id") REFERENCES "community_badges"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_members_worn_badge_id" ON "community_members" ("worn_badge_id") WHERE "worn_badge_id" IS NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "community_members" ADD "events_attended_count" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `UPDATE "community_members" "m"
       SET "events_attended_count" = "tally"."total"
       FROM (
         SELECT "cm"."id" AS "member_id", count(DISTINCT "r"."event_id")::int AS "total"
         FROM "community_members" "cm"
         JOIN "events" "e" ON "e"."community_id" = "cm"."community_id"
         JOIN "event_rsvps" "r" ON "r"."event_id" = "e"."id" AND "r"."user_id" = "cm"."user_id"
         WHERE "r"."checked_in_at" IS NOT NULL AND "r"."checked_in_at" >= "cm"."joined_at"
         GROUP BY "cm"."id"
       ) "tally"
       WHERE "m"."id" = "tally"."member_id"`,
    );

    for (const [
      position,
      seed,
    ] of COMMUNITY_BADGE_STARTER_SEEDS_1840700000000.entries()) {
      await queryRunner.query(
        `INSERT INTO "community_badges" ("community_id", "starter_key", "name", "icon_key", "tint", "rule_type", "threshold", "is_enabled", "created_by_id", "backfill_requested_at", "created_at", "updated_at")
         SELECT "c"."id", $1, $2, $3, $4, $5::"community_badges_rule_type_enum", $6, true, NULL, now(), now() + ($7 * interval '1 millisecond'), now() + ($7 * interval '1 millisecond')
         FROM "communities" "c"
         WHERE "c"."parent_id" IS NULL
         ON CONFLICT DO NOTHING`,
        [
          seed.starterKey,
          seed.name,
          seed.iconKey,
          seed.tint,
          seed.ruleType,
          seed.threshold,
          position,
        ],
      );
    }

    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_badge_earned'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_gift_received'`,
    );
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'badge_created'`,
    );
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'badge_updated'`,
    );
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'badge_deleted'`,
    );
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'gift_sent'`,
    );
    await queryRunner.query(
      `ALTER TYPE "community_governance_log_action_enum" ADD VALUE IF NOT EXISTS 'gift_removed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE IF NOT EXISTS 'community_gift'`,
    );
  }

  /**
   * The eight labels stay in their enums after this runs: Postgres cannot drop
   * an enum value, a label is inert once no row carries it, and
   * `IF NOT EXISTS` keeps a later `up()` re-runnable. Reports filed on gifts
   * stay as safety records.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "notifications" WHERE "type" IN ('community_badge_earned', 'community_gift_received')`,
    );
    await queryRunner.query(
      `DELETE FROM "community_governance_log" WHERE "action" IN ('badge_created', 'badge_updated', 'badge_deleted', 'gift_sent', 'gift_removed')`,
    );
    await queryRunner.query(`DROP INDEX "IDX_community_members_worn_badge_id"`);
    await queryRunner.query(
      `ALTER TABLE "community_members" DROP CONSTRAINT "FK_community_members_worn_badge_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_members" DROP COLUMN "worn_badge_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_members" DROP COLUMN "events_attended_count"`,
    );
    await queryRunner.query(`DROP TABLE "community_gifts"`);
    await queryRunner.query(`DROP TABLE "community_badge_awards"`);
    await queryRunner.query(`DROP TABLE "community_badges"`);
    await queryRunner.query(`DROP TYPE "community_badges_rule_type_enum"`);
  }
}
