// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';
import { emailTemplatesSeed } from '../email-templates/email-templates.seed';

/**
 * Inserts the starter email templates in every environment (the dev seed
 * refuses to run in production, and an empty library there would hide the copy
 * action). Copy comes from `email-templates.seed.ts`. Idempotent on
 * `UQ_email_templates_label`, so an admin's later edits are never overwritten.
 * Same shape as `SeedModResponseTemplates1794621000000`.
 */
export class SeedEmailTemplates1821800100000 implements MigrationInterface {
  name = 'SeedEmailTemplates1821800100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [index, template] of emailTemplatesSeed.entries()) {
      await queryRunner.query(
        `INSERT INTO "email_templates"
           ("label", "purpose", "locales", "sort_order", "is_active")
         VALUES ($1, $2, $3::jsonb, $4, true)
         ON CONFLICT ("label") DO NOTHING`,
        [
          template.label,
          template.purpose,
          JSON.stringify(template.locales),
          index,
        ],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "email_templates" WHERE "label" = ANY($1)`,
      [emailTemplatesSeed.map((template) => template.label)],
    );
  }
}
