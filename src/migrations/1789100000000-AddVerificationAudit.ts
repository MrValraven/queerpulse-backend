import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the append-only `verification_events` audit table plus provenance
 * columns on `member_verifications` (`type`, `granted_by`,
 * `reviewed_by_user_id`). Every level change is now attributable: who
 * granted/overrode it and whether it was member-earned or admin-granted.
 *
 * The prior `member_verifications` uniqueness was a single index on
 * `user_id` alone (see `AddMemberVerification1787800000000`, which created
 * `UQ_member_verifications_user_id` as a `CREATE UNIQUE INDEX`, not a table
 * constraint). This swaps it for uniqueness on `(user_id, type)` so a future
 * verification `type` dimension (beyond `identity`) can coexist per member.
 */
export class AddVerificationAudit1789100000000 implements MigrationInterface {
  name = 'AddVerificationAudit1789100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "verification_type_enum" AS ENUM ('identity')`);
    await queryRunner.query(`CREATE TYPE "verification_granted_by_enum" AS ENUM ('member_earned', 'admin_granted')`);
    await queryRunner.query(`CREATE TYPE "verification_event_action_enum" AS ENUM ('submitted', 'approved', 'rejected', 'overridden', 'downgraded', 'appealed', 'withdrawn')`);

    // member_verifications additions
    await queryRunner.query(`ALTER TABLE "member_verifications" ADD "type" "verification_type_enum" NOT NULL DEFAULT 'identity'`);
    await queryRunner.query(`ALTER TABLE "member_verifications" ADD "granted_by" "verification_granted_by_enum" NOT NULL DEFAULT 'member_earned'`);
    await queryRunner.query(`ALTER TABLE "member_verifications" ADD "reviewed_by_user_id" uuid`);
    await queryRunner.query(`ALTER TABLE "member_verifications" ADD CONSTRAINT "FK_member_verifications_reviewed_by" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL`);
    // swap uniqueness user_id -> (user_id, type). The original migration
    // created a plain unique INDEX (not a constraint) named
    // "UQ_member_verifications_user_id" — see
    // AddMemberVerification1787800000000. Guard both forms with IF EXISTS in
    // case a future schema variant ever expressed it as a table constraint.
    await queryRunner.query(`ALTER TABLE "member_verifications" DROP CONSTRAINT IF EXISTS "UQ_member_verifications_user_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_member_verifications_user_id"`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_member_verifications_user_type" ON "member_verifications" ("user_id", "type")`);

    // audit table
    await queryRunner.query(`
      CREATE TABLE "verification_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "request_id" uuid,
        "actor_user_id" uuid,
        "action" "verification_event_action_enum" NOT NULL,
        "from_level" "member_verification_level_enum",
        "to_level" "member_verification_level_enum",
        "reason" text,
        "signals" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_verification_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_verification_events_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_verification_events_actor" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_verification_events_user_created" ON "verification_events" ("user_id", "created_at")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_verification_events_user_created"`);
    await queryRunner.query(`DROP TABLE "verification_events"`);
    await queryRunner.query(`DROP INDEX "UQ_member_verifications_user_type"`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_member_verifications_user_id" ON "member_verifications" ("user_id")`);
    await queryRunner.query(`ALTER TABLE "member_verifications" DROP CONSTRAINT "FK_member_verifications_reviewed_by"`);
    await queryRunner.query(`ALTER TABLE "member_verifications" DROP COLUMN "reviewed_by_user_id"`);
    await queryRunner.query(`ALTER TABLE "member_verifications" DROP COLUMN "granted_by"`);
    await queryRunner.query(`ALTER TABLE "member_verifications" DROP COLUMN "type"`);
    await queryRunner.query(`DROP TYPE "verification_event_action_enum"`);
    await queryRunner.query(`DROP TYPE "verification_granted_by_enum"`);
    await queryRunner.query(`DROP TYPE "verification_type_enum"`);
  }
}
