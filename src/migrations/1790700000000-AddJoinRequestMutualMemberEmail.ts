import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a structured "someone who can vouch for me" field to platform join
 * requests.
 *
 * The request form always asked for this, but the email was folded into the
 * free-text `message` field — functional, but it meant a reviewer had to read
 * the whole message to find it, and nothing could match it against a real
 * member. This gives it its own nullable column so the admin queue can show
 * it as a structured line and, eventually, resolve it to an existing member.
 *
 * Nullable with no default and no backfill: most applicants have nobody to
 * name, and historical rows already carry the reference inside `message` —
 * this column only applies going forward.
 */
export class AddJoinRequestMutualMemberEmail1790700000000 implements MigrationInterface {
  name = 'AddJoinRequestMutualMemberEmail1790700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        ADD "mutual_member_email" character varying(254)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "join_requests"
        DROP COLUMN "mutual_member_email"
    `);
  }
}
