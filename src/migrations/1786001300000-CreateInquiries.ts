import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P3-12/P3-13 Inquiries: public marketing-form submissions (the Contact page and
 * the For-Organisations partnership form) landed for ops triage.
 *
 * One brand-new table, so its index is created inline as a plain `CREATE INDEX`
 * alongside `CREATE TABLE` (no `CONCURRENTLY` — nothing is reading it yet). The
 * `IDX_inquiries_status` index backs the admin triage list's `status = 'new'`
 * filter. `kind` and `status` are plain varchars (not Postgres enums) so adding
 * a future form kind or triage state never needs an enum migration — the allowed
 * values are enforced by the DTO on write. There is no `user_id`/FK: the POST is
 * public and anonymous, so the sender identifies themselves by the name/email
 * they type.
 */
export class CreateInquiries1786001300000 implements MigrationInterface {
  name = 'CreateInquiries1786001300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "inquiries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "kind" character varying NOT NULL,
        "sender_name" character varying NOT NULL,
        "email" character varying NOT NULL,
        "subject" character varying,
        "body" text NOT NULL,
        "org_name" character varying,
        "status" character varying NOT NULL DEFAULT 'new',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_inquiries" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_inquiries_status" ON "inquiries" ("status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_inquiries_status"`);
    await queryRunner.query(`DROP TABLE "inquiries"`);
  }
}
