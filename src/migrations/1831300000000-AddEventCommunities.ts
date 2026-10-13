// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `event_communities`: the guest communities of a gathering (2026-10-08
 * guest communities design). `events.community_id` stays the lead; each row
 * here is one invited guest with its own answer.
 *
 * `UQ_event_communities_event_community (event_id, community_id)` makes a
 * decline final for that gathering and backs `orIgnore` on insert. Its index
 * leads with `event_id`, which serves every per-gathering read, so the table
 * carries no separate `event_id` index.
 *
 * `IDX_event_communities_accepted_community_id` is partial on
 * `status = 'accepted'`: the community page, the feed and the digest only
 * ask which gatherings a community joined as an accepted guest.
 *
 * Plain indexes on `community_id`, `invited_by_user_id` and
 * `responded_by_user_id` keep a community delete and the user-erasure
 * `SET NULL` from scanning the table.
 *
 * Both parent FKs cascade, so a deleted gathering or community takes its
 * rows along. The two user FKs are `SET NULL`: an invite outlives the account
 * of whoever sent or answered it.
 */
export class AddEventCommunities1831300000000 implements MigrationInterface {
  name = 'AddEventCommunities1831300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "event_communities_status_enum" AS ENUM('pending', 'accepted', 'declined')`,
    );
    await queryRunner.query(`
      CREATE TABLE "event_communities" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_id" uuid NOT NULL,
        "community_id" uuid NOT NULL,
        "status" "event_communities_status_enum" NOT NULL DEFAULT 'pending',
        "invited_by_user_id" uuid,
        "responded_by_user_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "responded_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_event_communities" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_event_communities_event_community" UNIQUE ("event_id", "community_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_event_communities_accepted_community_id" ON "event_communities" ("community_id") WHERE "status" = 'accepted'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_event_communities_community_id" ON "event_communities" ("community_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_event_communities_invited_by_user_id" ON "event_communities" ("invited_by_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_event_communities_responded_by_user_id" ON "event_communities" ("responded_by_user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_communities" ADD CONSTRAINT "FK_event_communities_event_id" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_communities" ADD CONSTRAINT "FK_event_communities_community_id" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_communities" ADD CONSTRAINT "FK_event_communities_invited_by_user_id" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_communities" ADD CONSTRAINT "FK_event_communities_responded_by_user_id" FOREIGN KEY ("responded_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "event_communities" DROP CONSTRAINT "FK_event_communities_responded_by_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_communities" DROP CONSTRAINT "FK_event_communities_invited_by_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_communities" DROP CONSTRAINT "FK_event_communities_community_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_communities" DROP CONSTRAINT "FK_event_communities_event_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_event_communities_responded_by_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_event_communities_invited_by_user_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_event_communities_community_id"`);
    await queryRunner.query(
      `DROP INDEX "IDX_event_communities_accepted_community_id"`,
    );
    await queryRunner.query(`DROP TABLE "event_communities"`);
    await queryRunner.query(`DROP TYPE "event_communities_status_enum"`);
  }
}
