// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Membership cards, Phase 1. Creates the card programme, the individual
 * cards, and the (Phase 2) scan log.
 *
 * `membership_card_scans` is created empty and stays empty in Phase 1: door
 * check-in is Phase 2, and public verifications are deliberately not logged.
 * Creating it now keeps Phase 2 to a code change.
 *
 * Foreign keys follow the community precedent set by
 * `FixCommunityOwnerAuthorErasureCascades1789900000000`: a card belongs to
 * its holder and dies with them (CASCADE on `user_id`), and a scan's actor
 * reference survives that actor's erasure as NULL (SET NULL).
 */
export class AddMembershipCards1793650000000 implements MigrationInterface {
  name = 'AddMembershipCards1793650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "community_cards_issuer_type_enum" AS ENUM ('community', 'collective')
    `);
    await queryRunner.query(`
      CREATE TYPE "community_cards_skin_enum" AS ENUM ('plum', 'cream', 'jade', 'coral', 'ink')
    `);
    await queryRunner.query(`
      CREATE TYPE "membership_cards_status_enum" AS ENUM ('active', 'suspended', 'revoked')
    `);
    await queryRunner.query(`
      CREATE TYPE "membership_card_scans_result_enum" AS ENUM
        ('valid', 'expired', 'revoked', 'suspended', 'wrong_community', 'already_checked_in')
    `);

    await queryRunner.query(`
      CREATE TABLE "community_cards" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "issuer_type" "community_cards_issuer_type_enum" NOT NULL,
        "issuer_id" uuid NOT NULL,
        "is_enabled" boolean NOT NULL DEFAULT false,
        "skin" "community_cards_skin_enum" NOT NULL DEFAULT 'plum',
        "accent_token" character varying NOT NULL DEFAULT 'accent',
        "crest_media_key" character varying,
        "card_name" character varying NOT NULL DEFAULT 'Member',
        "validity_months" integer,
        "allows_print" boolean NOT NULL DEFAULT false,
        "allows_wallet" boolean NOT NULL DEFAULT false,
        "allows_public_badge" boolean NOT NULL DEFAULT true,
        "serial_prefix" character varying(3) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_community_cards" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_community_cards_issuer" UNIQUE ("issuer_type", "issuer_id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_community_cards_issuer_id" ON "community_cards" ("issuer_id")
    `);

    await queryRunner.query(`
      CREATE TABLE "membership_cards" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "program_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "serial" character varying NOT NULL,
        "status" "membership_cards_status_enum" NOT NULL DEFAULT 'active',
        "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "expires_at" TIMESTAMP WITH TIME ZONE,
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "revoked_reason" text,
        "is_publicly_visible" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_membership_cards" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_membership_cards_program_user" UNIQUE ("program_id", "user_id"),
        CONSTRAINT "FK_membership_cards_program" FOREIGN KEY ("program_id")
          REFERENCES "community_cards"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_membership_cards_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_membership_cards_serial" ON "membership_cards" ("serial")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_membership_cards_program_id" ON "membership_cards" ("program_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_membership_cards_user_issued"
        ON "membership_cards" ("user_id", "issued_at")
    `);

    await queryRunner.query(`
      CREATE TABLE "membership_card_scans" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "card_id" uuid NOT NULL,
        "event_id" uuid,
        "scanned_by_user_id" uuid,
        "result" "membership_card_scans_result_enum" NOT NULL,
        "scanned_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_membership_card_scans" PRIMARY KEY ("id"),
        CONSTRAINT "FK_membership_card_scans_card" FOREIGN KEY ("card_id")
          REFERENCES "membership_cards"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_membership_card_scans_scanner" FOREIGN KEY ("scanned_by_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_membership_card_scans_card_id"
        ON "membership_card_scans" ("card_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_membership_card_scans_scanned_at"
        ON "membership_card_scans" ("scanned_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "membership_card_scans"`);
    await queryRunner.query(`DROP TABLE "membership_cards"`);
    await queryRunner.query(`DROP TABLE "community_cards"`);
    await queryRunner.query(`DROP TYPE "membership_card_scans_result_enum"`);
    await queryRunner.query(`DROP TYPE "membership_cards_status_enum"`);
    await queryRunner.query(`DROP TYPE "community_cards_skin_enum"`);
    await queryRunner.query(`DROP TYPE "community_cards_issuer_type_enum"`);
  }
}
