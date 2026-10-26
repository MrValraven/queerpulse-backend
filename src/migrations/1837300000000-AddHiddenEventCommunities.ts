// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hidden event communities: a member's list of communities whose events stay
 * off their upcoming browse (Highlights, Browse, the calendar).
 *
 * A table of its own beside `feed_source_mutes`: that table is the feed's
 * preference and addresses two parents (communities and forum threads) with
 * no FK. This one is events-only and addresses one parent, so it carries real
 * foreign keys: a row dies with the member or the community it names.
 *
 * `UQ_hidden_event_communities_user_id_community_id` keeps one row per
 * (member, community) and leads with `user_id`, so it also serves the
 * per-request "this viewer's hidden community ids" read and the cap count.
 * `IDX_hidden_event_communities_community_id` serves the community cascade.
 *
 * The table is new and empty, so its index builds inside the migration
 * transaction.
 */
export class AddHiddenEventCommunities1837300000000 implements MigrationInterface {
  name = 'AddHiddenEventCommunities1837300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "hidden_event_communities" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "community_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_hidden_event_communities" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_hidden_event_communities_user_id_community_id" UNIQUE ("user_id", "community_id"),
        CONSTRAINT "FK_hidden_event_communities_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_hidden_event_communities_community_id" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_hidden_event_communities_community_id" ON "hidden_event_communities" ("community_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_hidden_event_communities_community_id"`,
    );
    await queryRunner.query(`DROP TABLE "hidden_event_communities"`);
  }
}
