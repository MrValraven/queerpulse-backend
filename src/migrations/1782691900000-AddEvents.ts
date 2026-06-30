import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEvents1782691900000 implements MigrationInterface {
  name = 'AddEvents1782691900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "events_visibility_enum" AS ENUM('public', 'members', 'invite_only')`,
    );
    await queryRunner.query(
      `CREATE TYPE "events_status_enum" AS ENUM('draft', 'published', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TYPE "event_rsvps_status_enum" AS ENUM('going', 'maybe', 'waitlisted', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TYPE "event_invites_status_enum" AS ENUM('pending', 'accepted', 'declined')`,
    );

    await queryRunner.query(`
      CREATE TABLE "events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "host_id" uuid NOT NULL,
        "slug" character varying NOT NULL,
        "title" character varying NOT NULL,
        "description" text NOT NULL,
        "start_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "end_at" TIMESTAMP WITH TIME ZONE,
        "timezone" character varying NOT NULL,
        "venue" character varying,
        "is_online" boolean NOT NULL DEFAULT false,
        "online_url" character varying,
        "capacity" integer,
        "visibility" "events_visibility_enum" NOT NULL DEFAULT 'public',
        "status" "events_status_enum" NOT NULL DEFAULT 'draft',
        "cover_image_url" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_events" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_events_slug" ON "events" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_events_host_id" ON "events" ("host_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "event_cohosts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        CONSTRAINT "PK_event_cohosts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_event_cohosts" UNIQUE ("event_id", "user_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_event_cohosts_event_id" ON "event_cohosts" ("event_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_event_cohosts_user_id" ON "event_cohosts" ("user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "event_rsvps" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "status" "event_rsvps_status_enum" NOT NULL,
        "waitlist_position" integer,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_event_rsvps" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_event_rsvps" UNIQUE ("event_id", "user_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_event_rsvps_event_id" ON "event_rsvps" ("event_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_event_rsvps_user_id" ON "event_rsvps" ("user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "event_invites" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_id" uuid NOT NULL,
        "inviter_id" uuid NOT NULL,
        "invitee_id" uuid NOT NULL,
        "status" "event_invites_status_enum" NOT NULL DEFAULT 'pending',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_event_invites" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_event_invites" UNIQUE ("event_id", "invitee_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_event_invites_event_id" ON "event_invites" ("event_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_event_invites_invitee_id" ON "event_invites" ("invitee_id")`,
    );

    // Foreign keys
    await queryRunner.query(`ALTER TABLE "events" ADD CONSTRAINT "FK_events_host_id" FOREIGN KEY ("host_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "event_cohosts" ADD CONSTRAINT "FK_event_cohosts_event_id" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "event_cohosts" ADD CONSTRAINT "FK_event_cohosts_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "event_rsvps" ADD CONSTRAINT "FK_event_rsvps_event_id" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "event_rsvps" ADD CONSTRAINT "FK_event_rsvps_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "event_invites" ADD CONSTRAINT "FK_event_invites_event_id" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "event_invites" ADD CONSTRAINT "FK_event_invites_inviter_id" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "event_invites" ADD CONSTRAINT "FK_event_invites_invitee_id" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "event_invites" DROP CONSTRAINT "FK_event_invites_invitee_id"`);
    await queryRunner.query(`ALTER TABLE "event_invites" DROP CONSTRAINT "FK_event_invites_inviter_id"`);
    await queryRunner.query(`ALTER TABLE "event_invites" DROP CONSTRAINT "FK_event_invites_event_id"`);
    await queryRunner.query(`ALTER TABLE "event_rsvps" DROP CONSTRAINT "FK_event_rsvps_user_id"`);
    await queryRunner.query(`ALTER TABLE "event_rsvps" DROP CONSTRAINT "FK_event_rsvps_event_id"`);
    await queryRunner.query(`ALTER TABLE "event_cohosts" DROP CONSTRAINT "FK_event_cohosts_user_id"`);
    await queryRunner.query(`ALTER TABLE "event_cohosts" DROP CONSTRAINT "FK_event_cohosts_event_id"`);
    await queryRunner.query(`ALTER TABLE "events" DROP CONSTRAINT "FK_events_host_id"`);
    await queryRunner.query(`DROP TABLE "event_invites"`);
    await queryRunner.query(`DROP TABLE "event_rsvps"`);
    await queryRunner.query(`DROP TABLE "event_cohosts"`);
    await queryRunner.query(`DROP TABLE "events"`);
    await queryRunner.query(`DROP TYPE "event_invites_status_enum"`);
    await queryRunner.query(`DROP TYPE "event_rsvps_status_enum"`);
    await queryRunner.query(`DROP TYPE "events_status_enum"`);
    await queryRunner.query(`DROP TYPE "events_visibility_enum"`);
  }
}
