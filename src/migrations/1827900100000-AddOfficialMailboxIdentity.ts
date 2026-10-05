// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The QueerPulse Team mailbox, part two (after
 * `AddOfficialIdentityKind1827900000000` added the enum label).
 *
 * 1. The two owner CHECKs learn the `official` kind: its one row is owned by
 *    no entity, so every owner column stays null, and every other kind keeps
 *    exactly the one owner column it always had.
 * 2. `UQ_identities_official` makes "one QueerPulse Team" a database
 *    guarantee, so `IdentitiesService.resolveOfficialIdentityId`'s
 *    get-or-create converges on one row under a race.
 * 3. The row itself.
 * 4. Every message the house account already posted into an official thread
 *    is attributed to that identity, as every new one is
 *    (`MessagingCoreService.postMessage`). Staff then read the platform's own
 *    earlier messages on their side of the thread, and the member reads them
 *    from the QueerPulse Team as before. Bounded by the official messages and
 *    broadcasts sent so far, one row per member per send.
 */
export class AddOfficialMailboxIdentity1827900100000 implements MigrationInterface {
  name = 'AddOfficialMailboxIdentity1827900100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "identities" DROP CONSTRAINT "CHK_identities_exactly_one_owner"`,
    );
    await queryRunner.query(`
      ALTER TABLE "identities" ADD CONSTRAINT "CHK_identities_exactly_one_owner" CHECK (
        (CASE WHEN "user_id"       IS NULL THEN 0 ELSE 1 END
       + CASE WHEN "subprofile_id" IS NULL THEN 0 ELSE 1 END
       + CASE WHEN "listing_id"    IS NULL THEN 0 ELSE 1 END
       + CASE WHEN "company_id"    IS NULL THEN 0 ELSE 1 END)
        = CASE WHEN "kind" = 'official' THEN 0 ELSE 1 END
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "identities" DROP CONSTRAINT "CHK_identities_owner_matches_kind"`,
    );
    await queryRunner.query(`
      ALTER TABLE "identities" ADD CONSTRAINT "CHK_identities_owner_matches_kind" CHECK (
        ("kind" = 'profile'    AND "user_id"       IS NOT NULL) OR
        ("kind" = 'subprofile' AND "subprofile_id" IS NOT NULL) OR
        ("kind" = 'listing'    AND "listing_id"    IS NOT NULL) OR
        ("kind" = 'company'    AND "company_id"    IS NOT NULL) OR
        ("kind" = 'official')
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_identities_official" ON "identities" ("kind")
        WHERE "kind" = 'official'
    `);
    await queryRunner.query(
      `INSERT INTO "identities" ("kind") VALUES ('official')`,
    );
    await queryRunner.query(`
      UPDATE "messages" message
      SET "sender_identity_id" = official."id"
      FROM "identities" official, "conversations" conversation, "users" sender
      WHERE official."kind" = 'official'
        AND conversation."id" = message."conversation_id"
        AND conversation."is_official" = true
        AND sender."id" = message."sender_id"
        AND sender."is_system" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The house account's messages go back to its own profile identity, the
    // attribution they carried before.
    await queryRunner.query(`
      UPDATE "messages" message
      SET "sender_identity_id" = profile_identity."id"
      FROM "identities" official, "identities" profile_identity
      WHERE official."kind" = 'official'
        AND message."sender_identity_id" = official."id"
        AND profile_identity."kind" = 'profile'
        AND profile_identity."user_id" = message."sender_id"
    `);
    await queryRunner.query(`
      DELETE FROM "conversation_participants" seat
      USING "identities" official
      WHERE official."kind" = 'official' AND seat."identity_id" = official."id"
    `);
    await queryRunner.query(
      `DELETE FROM "identities" WHERE "kind" = 'official'`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_identities_official"`);
    await queryRunner.query(
      `ALTER TABLE "identities" DROP CONSTRAINT "CHK_identities_owner_matches_kind"`,
    );
    await queryRunner.query(`
      ALTER TABLE "identities" ADD CONSTRAINT "CHK_identities_owner_matches_kind" CHECK (
        ("kind" = 'profile'    AND "user_id"       IS NOT NULL) OR
        ("kind" = 'subprofile' AND "subprofile_id" IS NOT NULL) OR
        ("kind" = 'listing'    AND "listing_id"    IS NOT NULL) OR
        ("kind" = 'company'    AND "company_id"    IS NOT NULL)
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "identities" DROP CONSTRAINT "CHK_identities_exactly_one_owner"`,
    );
    await queryRunner.query(`
      ALTER TABLE "identities" ADD CONSTRAINT "CHK_identities_exactly_one_owner" CHECK (
        (CASE WHEN "user_id"       IS NULL THEN 0 ELSE 1 END
       + CASE WHEN "subprofile_id" IS NULL THEN 0 ELSE 1 END
       + CASE WHEN "listing_id"    IS NULL THEN 0 ELSE 1 END
       + CASE WHEN "company_id"    IS NULL THEN 0 ELSE 1 END) = 1
      )
    `);
  }
}
