import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records which frontend entry point a join request came through.
 *
 * The public invite request form (`POST /join-requests`) is reached from many
 * CTAs — the homepage hero, the sign-in page, several economy directories — but
 * until now the admin verification queue could not tell them apart. This adds a
 * nullable `source` key so the queue can show "came from …" next to each
 * applicant.
 *
 * Nullable with no default and no backfill: it is a soft attribution signal, not
 * a required field. Rows written before this column, and applicants who open the
 * request page directly with no originating CTA, legitimately have no source.
 * The value is a closed-set key owned by the frontend catalogue
 * (`features/auth/api/joinRequestSource.ts`) and length-capped by
 * `CreateMembershipJoinRequestDto`, so a `varchar(64)` rather than a Postgres enum that
 * would need a migration per new CTA.
 */
export class AddJoinRequestSource1789500000000 implements MigrationInterface {
  name = 'AddJoinRequestSource1789500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        ADD "source" character varying(64)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        DROP COLUMN "source"
    `);
  }
}
