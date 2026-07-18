import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records the 18+ self-attestation required to create an account
 * (Terms §eligibility). `age_attested_at` is the timestamp of the affirmative
 * act; `terms_version` pins which revision of the Terms it was made against, so
 * a later Terms change doesn't silently rewrite what people agreed to.
 *
 * Both are nullable, and deliberately NOT backfilled. Every row existing when
 * this runs predates the gate, and stamping them with a timestamp would
 * manufacture an attestation that never happened — the opposite of what an
 * audit trail is for. NULL here means exactly "no attestation on file", which
 * is the truth. `AuthUser.ageAttestedAt` surfaces that null to the client so
 * the frontend can decide whether to re-prompt existing members.
 *
 * Enforcement lives in AuthService.validateOrCreateGoogleUser and applies only
 * to NEW signups, so this migration cannot lock out existing members.
 */
export class AddAgeAttestation1782800690000 implements MigrationInterface {
  name = 'AddAgeAttestation1782800690000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD "age_attested_at" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD "terms_version" character varying(32)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN "terms_version"
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN "age_attested_at"
    `);
  }
}
