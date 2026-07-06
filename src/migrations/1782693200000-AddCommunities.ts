import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCommunities1782693200000 implements MigrationInterface {
  name = 'AddCommunities1782693200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "communities_type_enum" AS ENUM('social', 'arts', 'activism', 'support', 'sports', 'professional')`,
    );
    await queryRunner.query(
      `CREATE TYPE "communities_access_tier_enum" AS ENUM('public', 'request', 'invite', 'private')`,
    );
    await queryRunner.query(
      `CREATE TYPE "community_members_role_enum" AS ENUM('owner', 'mod', 'member')`,
    );
    await queryRunner.query(
      `CREATE TYPE "community_posts_kind_enum" AS ENUM('post', 'announcement')`,
    );
    await queryRunner.query(
      `CREATE TYPE "community_post_reactions_key_enum" AS ENUM('heart', 'celebrate', 'support', 'fire')`,
    );
    await queryRunner.query(
      `CREATE TYPE "community_join_requests_status_enum" AS ENUM('pending', 'approved', 'declined')`,
    );

    await queryRunner.query(`
      CREATE TABLE "communities" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "name" character varying NOT NULL,
        "purpose" text NOT NULL,
        "type" "communities_type_enum" NOT NULL,
        "who_for" text NOT NULL,
        "tagline" character varying NOT NULL,
        "access_tier" "communities_access_tier_enum" NOT NULL,
        "roster_visible" boolean NOT NULL DEFAULT true,
        "features" text array NOT NULL DEFAULT '{}',
        "rules" text array NOT NULL DEFAULT '{}',
        "owner_id" uuid NOT NULL,
        "ref" character varying NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_communities" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_communities_slug" ON "communities" ("slug")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_communities_ref" ON "communities" ("ref")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_communities_owner_id" ON "communities" ("owner_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "community_members" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "community_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "role" "community_members_role_enum" NOT NULL,
        "joined_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_community_members" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_community_members" UNIQUE ("community_id", "user_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_community_members_community_id" ON "community_members" ("community_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_members_user_id" ON "community_members" ("user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "community_posts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "community_id" uuid NOT NULL,
        "author_id" uuid NOT NULL,
        "body" text NOT NULL,
        "image" character varying,
        "kind" "community_posts_kind_enum" NOT NULL DEFAULT 'post',
        "pinned" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_community_posts" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_community_posts_community_id" ON "community_posts" ("community_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_posts_author_id" ON "community_posts" ("author_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "community_post_reactions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "post_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "key" "community_post_reactions_key_enum" NOT NULL,
        CONSTRAINT "PK_community_post_reactions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_community_post_reactions" UNIQUE ("post_id", "user_id", "key")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_community_post_reactions_post_id" ON "community_post_reactions" ("post_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_post_reactions_user_id" ON "community_post_reactions" ("user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "community_post_replies" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "post_id" uuid NOT NULL,
        "author_id" uuid NOT NULL,
        "text" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_community_post_replies" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_community_post_replies_post_id" ON "community_post_replies" ("post_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_post_replies_author_id" ON "community_post_replies" ("author_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "community_join_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "community_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "note" text,
        "status" "community_join_requests_status_enum" NOT NULL DEFAULT 'pending',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_community_join_requests" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_community_join_requests_community_id" ON "community_join_requests" ("community_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_join_requests_user_id" ON "community_join_requests" ("user_id")`,
    );
    // Enforce at most one *pending* join request per (community, user) at the
    // database level. A partial unique index ignores approved/declined rows,
    // so a user can re-apply after a decline while a concurrent double-submit
    // is rejected with a 23505 the service maps to 409. Mirrors
    // `AddJoinRequestPendingUnique`.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_community_join_requests_pending" ` +
        `ON "community_join_requests" ("community_id", "user_id") WHERE "status" = 'pending'`,
    );

    // Foreign keys
    await queryRunner.query(
      `ALTER TABLE "communities" ADD CONSTRAINT "FK_communities_owner_id" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_members" ADD CONSTRAINT "FK_community_members_community_id" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_members" ADD CONSTRAINT "FK_community_members_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_posts" ADD CONSTRAINT "FK_community_posts_community_id" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_posts" ADD CONSTRAINT "FK_community_posts_author_id" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_post_reactions" ADD CONSTRAINT "FK_community_post_reactions_post_id" FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_post_reactions" ADD CONSTRAINT "FK_community_post_reactions_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_post_replies" ADD CONSTRAINT "FK_community_post_replies_post_id" FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_post_replies" ADD CONSTRAINT "FK_community_post_replies_author_id" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_join_requests" ADD CONSTRAINT "FK_community_join_requests_community_id" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_join_requests" ADD CONSTRAINT "FK_community_join_requests_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_join_requests" DROP CONSTRAINT "FK_community_join_requests_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_join_requests" DROP CONSTRAINT "FK_community_join_requests_community_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_post_replies" DROP CONSTRAINT "FK_community_post_replies_author_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_post_replies" DROP CONSTRAINT "FK_community_post_replies_post_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_post_reactions" DROP CONSTRAINT "FK_community_post_reactions_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_post_reactions" DROP CONSTRAINT "FK_community_post_reactions_post_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_posts" DROP CONSTRAINT "FK_community_posts_author_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_posts" DROP CONSTRAINT "FK_community_posts_community_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_members" DROP CONSTRAINT "FK_community_members_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_members" DROP CONSTRAINT "FK_community_members_community_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "communities" DROP CONSTRAINT "FK_communities_owner_id"`,
    );

    await queryRunner.query(`DROP INDEX "UQ_community_join_requests_pending"`);
    await queryRunner.query(`DROP TABLE "community_join_requests"`);
    await queryRunner.query(`DROP TABLE "community_post_replies"`);
    await queryRunner.query(`DROP TABLE "community_post_reactions"`);
    await queryRunner.query(`DROP TABLE "community_posts"`);
    await queryRunner.query(`DROP TABLE "community_members"`);
    await queryRunner.query(`DROP TABLE "communities"`);

    await queryRunner.query(`DROP TYPE "community_join_requests_status_enum"`);
    await queryRunner.query(`DROP TYPE "community_post_reactions_key_enum"`);
    await queryRunner.query(`DROP TYPE "community_posts_kind_enum"`);
    await queryRunner.query(`DROP TYPE "community_members_role_enum"`);
    await queryRunner.query(`DROP TYPE "communities_access_tier_enum"`);
    await queryRunner.query(`DROP TYPE "communities_type_enum"`);
  }
}
