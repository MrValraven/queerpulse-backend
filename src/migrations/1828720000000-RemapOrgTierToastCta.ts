import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Moves every org tier stored with the retired `toast` CTA onto `propose`
 * (PRD-456). A `toast` button only showed a toast repeating its own label, so
 * an organisation clicking "Discuss funding" reached nobody. The write DTO
 * stopped accepting `toast` and `toOrgTier` already reads a stored toast row
 * back as `propose`; this brings the stored rows in line with what the page
 * renders.
 *
 * DATA CHANGE: `cta_type` is overwritten on the matching rows. The Postgres
 * enum `org_tiers_cta_type_enum` keeps its `toast` value, so no type is
 * altered and older code can still read the table.
 *
 * `down()` is a no-op: after `up()` a former toast row is indistinguishable
 * from a tier an admin set to `propose`, and the read path maps toast to
 * propose anyway, so restoring the old value would change nothing a person
 * sees.
 */
export class RemapOrgTierToastCta1828720000000 implements MigrationInterface {
  name = 'RemapOrgTierToastCta1828720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "org_tiers" SET "cta_type" = 'propose', "cta_target" = NULL WHERE "cta_type" = 'toast'`,
    );
  }

  public async down(): Promise<void> {
    // Irreversible by design; see the class comment.
  }
}
