import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Normalized member-written safe-space vouches. Distinct from the
 * moderator-curated `listings.safe_space_vouches` jsonb column — this is a
 * separate table (`safe_space_member_vouches`, non-colliding name) that a member
 * writes to once per space via `POST /safe-spaces/:slug/vouch`. Mirrors the
 * `vouches` table: UNIQUE(listing_id, voucher_id) enforces one vouch per space,
 * `withdrawn_at` soft-deletes. Plain CREATE TABLE (no enum ADD VALUE), so a
 * single-phase transactional migration is fine.
 */
export class CreateSafeSpaceMemberVouches1786002000000 implements MigrationInterface {
  name = 'CreateSafeSpaceMemberVouches1786002000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "safe_space_member_vouches" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "listing_id" uuid NOT NULL,
         "voucher_id" uuid NOT NULL,
         "note" text,
         "relationship" character varying(40),
         "anonymous" boolean NOT NULL DEFAULT false,
         "withdrawn_at" timestamptz,
         "created_at" timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT "PK_safe_space_member_vouches" PRIMARY KEY ("id"),
         CONSTRAINT "UQ_safe_space_member_vouches_listing_voucher" UNIQUE ("listing_id", "voucher_id")
       )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_safe_space_member_vouches_listing_id" ON "safe_space_member_vouches" ("listing_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_safe_space_member_vouches_voucher_id" ON "safe_space_member_vouches" ("voucher_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_safe_space_member_vouches_voucher_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_safe_space_member_vouches_listing_id"`,
    );
    await queryRunner.query(`DROP TABLE "safe_space_member_vouches"`);
  }
}
