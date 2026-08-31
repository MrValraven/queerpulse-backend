import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `event_cohost_invites`: a real invite→accept/decline lifecycle for
 * co-hosting a gathering (SDD 2026-08-18 "cohost invite flow"), replacing the
 * mocked `/co-host-invite` page. Distinct from the existing flat
 * `event_cohosts` roster join table: this one tracks the pending ask itself
 * (role, commitment, optional message/reply-by date, status) before a row is
 * ever written to `event_cohosts` on accept.
 *
 * `UQ_event_cohost_invites (event_id, invitee_id)` mirrors `event_invites`
 * exactly; one outstanding invite per (event, invitee) pair, inserted with
 * `.orIgnore()`; re-inviting after a decline is out of scope for this pass.
 * Both FKs cascade on delete, matching the rest of the events family.
 */
export class AddEventCohostInvites1790400000000 implements MigrationInterface {
  name = 'AddEventCohostInvites1790400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "event_cohost_invites_status_enum" AS ENUM('pending', 'accepted', 'declined')`,
    );
    await queryRunner.query(`
      CREATE TABLE "event_cohost_invites" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_id" uuid NOT NULL,
        "inviter_id" uuid NOT NULL,
        "invitee_id" uuid NOT NULL,
        "role" character varying(40) NOT NULL,
        "commitment" character varying(40) NOT NULL,
        "message" text,
        "reply_by_date" TIMESTAMP WITH TIME ZONE,
        "status" "event_cohost_invites_status_enum" NOT NULL DEFAULT 'pending',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_event_cohost_invites" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_event_cohost_invites" UNIQUE ("event_id", "invitee_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_event_cohost_invites_event_id" ON "event_cohost_invites" ("event_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_event_cohost_invites_invitee_id" ON "event_cohost_invites" ("invitee_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_cohost_invites" ADD CONSTRAINT "FK_event_cohost_invites_event_id" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_cohost_invites" ADD CONSTRAINT "FK_event_cohost_invites_inviter_id" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_cohost_invites" ADD CONSTRAINT "FK_event_cohost_invites_invitee_id" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "event_cohost_invites" DROP CONSTRAINT "FK_event_cohost_invites_invitee_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_cohost_invites" DROP CONSTRAINT "FK_event_cohost_invites_inviter_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_cohost_invites" DROP CONSTRAINT "FK_event_cohost_invites_event_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_event_cohost_invites_invitee_id"`);
    await queryRunner.query(`DROP INDEX "IDX_event_cohost_invites_event_id"`);
    await queryRunner.query(`DROP TABLE "event_cohost_invites"`);
    await queryRunner.query(`DROP TYPE "event_cohost_invites_status_enum"`);
  }
}
