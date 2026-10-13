// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  convertListingAttributesRowUp,
  restoreListingLanguagesRowDown,
} from '../database/listing-attributes-migration';

/**
 * Listing attributes (`QUEERPULSE-LISTING-ATTRIBUTES-DESIGN-2026-10-08.md`).
 *
 * Schema: `attributes` and `highlights` (slugs from the attribute
 * vocabulary), the "getting in" facts `entry_mode`, `cover_policy`,
 * `cover_free_before`, `payments` and `issues_nif_invoices`, the inclusion
 * practices with `safer_space_policy_url`, and `langs_other` beside `langs`,
 * which now holds language codes. The two GIN indexes are built by
 * `AddListingAttributeIndexes1830800100000`, outside a transaction.
 *
 * Data: every row's `tags` and `good_for` map onto `attributes`, `highlights`,
 * `entry_mode` and `cover_policy`, and its `langs` names onto codes plus
 * `langs_other`. The conversions live in
 * `src/database/listing-attributes-migration.ts`, frozen and pinned by its
 * spec. Rows are converted one at a time in TypeScript, the pattern
 * `AddListingOnlineDetails1830100200000` follows: listings are a small set,
 * and a per-row conversion is one a spec can pin. `tags` and `good_for` are
 * left untouched, unread and unwritten from here on, so the data stays
 * recoverable until a later migration drops them. `owned_by` gains the
 * `migrant` value with no data change.
 *
 * Backup: `langs` is the one old column this migration rewrites, so `up`
 * first copies every row's original `langs` into `langs_before_attributes`
 * (`text[]`, nullable), before any row is converted. The column is
 * deliberately unmapped: no entity property reads or writes it, and the later
 * migration that drops `tags` and `good_for` drops it with them. Until then,
 * `migration:generate` will propose dropping it; leave that out of any
 * generated migration.
 *
 * `down` restores `langs` from `langs_before_attributes` on every row that
 * has a backup. A row created after `up` has none (the column is NULL), so its
 * codes map back to the old names with the `langs_other` parts appended. The
 * choice is `restoreListingLanguagesRowDown`, pinned by the spec. `down` then
 * removes `migrant` from `owned_by`, which the earlier code does not know,
 * and drops the columns, the backup included. `tags` and `good_for` were never
 * touched, so they need no restore.
 */
export class AddListingAttributes1830800000000 implements MigrationInterface {
  name = 'AddListingAttributes1830800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "attributes" text array NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "highlights" text array NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "entry_mode" character varying(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "cover_policy" character varying(16)`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "cover_free_before" character varying(5)`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "payments" text array NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "issues_nif_invoices" boolean`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "inclusion_practices" text array NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "safer_space_policy_url" character varying(300)`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "langs_other" character varying(80) NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "langs_before_attributes" text array`,
    );
    // The backup is taken before the row loop rewrites a single `langs` value.
    await queryRunner.query(
      `UPDATE "listings" SET "langs_before_attributes" = "langs"`,
    );

    const rows: {
      id: string;
      online: boolean | null;
      cats: (string | null)[] | null;
      tags: (string | null)[] | null;
      good_for: (string | null)[] | null;
      langs: (string | null)[] | null;
    }[] = await queryRunner.query(
      `SELECT "id", "online", "cats", "tags", "good_for", "langs" FROM "listings"`,
    );
    for (const row of rows) {
      const converted = convertListingAttributesRowUp({
        online: row.online,
        cats: row.cats,
        tags: row.tags,
        goodFor: row.good_for,
        langs: row.langs,
      });
      await queryRunner.query(
        `UPDATE "listings" SET "attributes" = $1, "highlights" = $2, "entry_mode" = $3, "cover_policy" = $4, "langs" = $5, "langs_other" = $6 WHERE "id" = $7`,
        [
          converted.attributes,
          converted.highlights,
          converted.entryMode,
          converted.coverPolicy,
          converted.langs,
          converted.langsOther,
          row.id,
        ],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: {
      id: string;
      langs: (string | null)[] | null;
      langs_other: string | null;
      langs_before_attributes: (string | null)[] | null;
    }[] = await queryRunner.query(
      `SELECT "id", "langs", "langs_other", "langs_before_attributes" FROM "listings" WHERE "langs_before_attributes" IS NOT NULL OR "langs" <> '{}' OR "langs_other" <> ''`,
    );
    for (const row of rows) {
      const restored = restoreListingLanguagesRowDown({
        langsBeforeAttributes: row.langs_before_attributes,
        langs: row.langs,
        langsOther: row.langs_other,
      });
      await queryRunner.query(
        `UPDATE "listings" SET "langs" = $1 WHERE "id" = $2`,
        [restored.langs, row.id],
      );
    }
    // The earlier code knows four owned-by values; a fifth would 400 every
    // directory filter that echoed it back.
    await queryRunner.query(
      `UPDATE "listings" SET "owned_by" = array_remove("owned_by", 'migrant') WHERE 'migrant' = ANY("owned_by")`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "langs_before_attributes"`,
    );
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "langs_other"`);
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "safer_space_policy_url"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "inclusion_practices"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "issues_nif_invoices"`,
    );
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "payments"`);
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "cover_free_before"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "cover_policy"`,
    );
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "entry_mode"`);
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "highlights"`);
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "attributes"`);
  }
}
