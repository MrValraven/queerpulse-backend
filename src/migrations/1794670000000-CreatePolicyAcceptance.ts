import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `policy_acceptance`: append-only evidence that a member agreed to a specific
 * revision of the Terms and the Community Guidelines at a specific moment
 * (ID-14).
 *
 * THE GATE ITSELF NEEDS NO MIGRATION. `users.terms_version` and
 * `users.guidelines_version` already exist (`AddAgeAttestation…`,
 * `AddGuidelinesAgreement1785800100000`); they were simply written once at
 * signup and never read again. Comparing them to the server's current versions
 * on `GET /auth/me` and re-prompting is pure application code.
 *
 * THIS TABLE IS THE EVIDENCE HALF, and it is the half the columns cannot do.
 * Those two columns are single cells: the next acceptance overwrites the last.
 * The stated point of the item is that if a member is later moderated under a
 * rule added after they joined, someone can show they saw it — which a cell
 * holding only the newest value can never answer. Each row here keeps the dated
 * before/after pair the overwrite destroys.
 *
 * WHY NOT `consent_record`. It is the obvious reuse and it is wrong:
 * `ConsentService.myConsent` defines a member's CURRENT cookie/monitoring
 * consent as "the latest `consent_record` row", so appending a policy row there
 * would silently rewrite their cookie consent as `analytics: false,
 * monitoring: false` — a withdrawal they never made.
 *
 * No unique constraint: history IS the product. A member who agrees to 1.0,
 * then 1.1, then 1.2 leaves three rows.
 *
 * `previous_*_version` are nullable because an account that predates the
 * columns, or one agreeing for the first time, genuinely has no prior revision;
 * a manufactured value would be a lie in exactly the record meant to be
 * defensible.
 *
 * The FK CASCADEs: an erased account takes its own consent history with it,
 * matching `consent_record` and every other member-private log.
 *
 * `IDX_policy_acceptance_user_id` on `(user_id, created_at)` backs the only
 * read this table has — "show me this member's acceptance history, newest
 * first". No `CREATE INDEX CONCURRENTLY` is needed: the table is created empty
 * in this same migration, so the index builds on nothing and the file stays
 * transactional.
 */
export class CreatePolicyAcceptance1794670000000 implements MigrationInterface {
  name = 'CreatePolicyAcceptance1794670000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "policy_acceptance_source_enum" AS ENUM ('onboarding', 'reacceptance')
    `);
    await queryRunner.query(`
      CREATE TABLE "policy_acceptance" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "terms_version" character varying(32) NOT NULL,
        "guidelines_version" character varying(32) NOT NULL,
        "previous_terms_version" character varying(32),
        "previous_guidelines_version" character varying(32),
        "source" "policy_acceptance_source_enum" NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_policy_acceptance" PRIMARY KEY ("id"),
        CONSTRAINT "FK_policy_acceptance_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_policy_acceptance_user_id"
        ON "policy_acceptance" ("user_id", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_policy_acceptance_user_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "policy_acceptance"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "policy_acceptance_source_enum"`,
    );
  }
}
