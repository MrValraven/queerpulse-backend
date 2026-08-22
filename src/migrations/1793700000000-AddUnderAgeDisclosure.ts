import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records a member's self-declaration that they are under 18
 * (`POST /auth/under-18-disclosure`, fired by the onboarding wizard's
 * "I'm not 18 yet" branch).
 *
 * Until now the platform simply discarded that knowledge: the frontend ended
 * the flow honestly (sign out plus a contact link), but the account itself
 * stayed a fully active adult-community account, reachable again on the next
 * Google sign-in. `under_age_disclosed_at` is the durable record of the
 * disclosure; the route pairs it with `status = 'suspended'` and a NULL
 * `suspended_until` (permanent, never self-expires — mirroring how a ban is
 * modelled in `AccountEnforcementService`) and revokes the member's live
 * sessions.
 *
 * Nullable and deliberately NOT backfilled, exactly like `age_attested_at`
 * (`AddAgeAttestation1782800690000`) and `guidelines_accepted_at`: NULL means
 * "no disclosure on file", which is the truth for every row existing when this
 * runs. Manufacturing a timestamp would invent a declaration nobody made.
 *
 * No index: this column is only ever read for one member at a time, by primary
 * key, on the disclosure route itself.
 */
export class AddUnderAgeDisclosure1793700000000 implements MigrationInterface {
  name = 'AddUnderAgeDisclosure1793700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD "under_age_disclosed_at" TIMESTAMP WITH TIME ZONE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN "under_age_disclosed_at"
    `);
  }
}
