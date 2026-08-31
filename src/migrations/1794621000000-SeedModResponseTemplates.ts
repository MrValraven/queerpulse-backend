import { MigrationInterface, QueryRunner } from 'typeorm';
import { modResponseTemplatesSeed } from '../mod-response-templates/mod-response-templates.seed';

/**
 * Populates `mod_response_templates` with the starter response library in
 * every environment.
 *
 * WHY A DATA MIGRATION RATHER THAN THE DEV SEED. `src/database/seed.ts`
 * refuses to run under `NODE_ENV=production` (it also inserts fixture
 * members), so seeding there would leave production with the table created and
 * empty. An empty library in production is exactly the situation this feature
 * exists to fix: the picker would open on nothing and moderators would go back
 * to typing every note from scratch. Same reasoning, and the same shape, as
 * `SeedGovernanceContent1788600000000`.
 *
 * SINGLE SOURCE OF THE COPY. The rows are imported from
 * `mod-response-templates.seed.ts` rather than transcribed here, so the words
 * cannot drift between the two files.
 *
 * ORDERING. `sort_order` is the array index, so the library opens in the order
 * the copy was written: the two "close it without acting" notes first, then the
 * enforcement notes grouped by reason. An admin can reorder afterwards and this
 * migration never runs again to undo it.
 *
 * AUTHOR. `created_by_user_id` stays NULL. These are platform defaults, and
 * attributing them to whichever staff account happened to exist at migration
 * time would be a fiction. The column is nullable precisely because an author
 * may be absent.
 *
 * IDEMPOTENT. `ON CONFLICT ("label") DO NOTHING` against
 * `UQ_mod_response_templates_label`, so re-running never duplicates a template
 * and never overwrites an edit an admin has already made to one.
 */
export class SeedModResponseTemplates1794621000000 implements MigrationInterface {
  name = 'SeedModResponseTemplates1794621000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [index, template] of modResponseTemplatesSeed.entries()) {
      await queryRunner.query(
        `INSERT INTO "mod_response_templates"
           ("label", "body", "reason_code", "action_code", "sort_order", "is_active")
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT ("label") DO NOTHING`,
        [
          template.label,
          template.body,
          template.reasonCode,
          template.actionCode,
          index,
        ],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Removes only the rows this migration inserted, matched by their exact
    // seeded label. A template an admin wrote by hand is left alone.
    await queryRunner.query(
      `DELETE FROM "mod_response_templates" WHERE "label" = ANY($1)`,
      [modResponseTemplatesSeed.map((template) => template.label)],
    );
  }
}
