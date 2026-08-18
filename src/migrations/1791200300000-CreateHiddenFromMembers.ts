import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `hidden_from_members` — "hide my profile from one person" (member profile
 * v2 Task 5), a new, distinct safety primitive from `blocks`/`mutes`
 * (`AddBlocksMutes1782800010000`): one-way, silent (no notification to
 * either side), and narrower than a mute — it only affects whether the
 * owner's profile can be found (directory search + direct slug URL), not
 * messaging or feeds. Mirrors that migration's table/index/FK shape exactly.
 *
 * No `CREATE INDEX CONCURRENTLY` needed: the table is new in this migration,
 * so there is nothing to lock, and it runs inside the default transactional
 * mode per this plan's Global Constraints.
 */
export class CreateHiddenFromMembers1791200300000 implements MigrationInterface {
  name = 'CreateHiddenFromMembers1791200300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "hidden_from_members" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "owner_id" uuid NOT NULL,
        "hidden_from_user_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_hidden_from_members" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_hidden_from_pair" UNIQUE ("owner_id", "hidden_from_user_id"),
        CONSTRAINT "CHK_hidden_from_not_self" CHECK ("owner_id" <> "hidden_from_user_id")
      )
    `);
    // Reverse-lookup index: "am I hidden from this owner" (excludeHiddenFrom's
    // NOT EXISTS, and the single-profile-read gate) is checked on every
    // directory search request and every direct profile view for the current
    // viewer, keyed by (hidden_from_user_id, owner_id) — the viewer side
    // leads so both lookups use it as a leading-column match.
    await queryRunner.query(
      `CREATE INDEX "IDX_hidden_from_viewer" ON "hidden_from_members" ("hidden_from_user_id", "owner_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "hidden_from_members" ADD CONSTRAINT "FK_hidden_from_members_owner_id"
        FOREIGN KEY ("owner_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "hidden_from_members" ADD CONSTRAINT "FK_hidden_from_members_hidden_from_user_id"
        FOREIGN KEY ("hidden_from_user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "hidden_from_members" DROP CONSTRAINT "FK_hidden_from_members_hidden_from_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "hidden_from_members" DROP CONSTRAINT "FK_hidden_from_members_owner_id"`,
    );
    await queryRunner.query(`DROP TABLE "hidden_from_members"`);
  }
}
