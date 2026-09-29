// DO NOT RUN: authored for review only; the maintainer runs migrations.
// Applied at backend boot while pending: `ensureDatabaseSchema` (called from
// `src/main.ts`) runs every pending migration at startup unless
// `AUTO_RUN_MIGRATIONS=false` is set. To apply it by hand instead, set that
// flag, check `pnpm run typeorm migration:show`, then `pnpm run migration:run`.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `stickers.label_pt` and `sticker_packs.name_pt`: the Portuguese name of a
 * sticker and of a pack, beside the English `label` and `name`.
 *
 * WHY THE COLUMNS EXIST. A sticker's name is its alt text, its button label
 * in the picker and its reply-quote line, and a pack's name heads its section
 * in the picker. Both were stored once, in whatever language the publishing
 * admin had the builder set to, so a member reading in the other language saw
 * the wrong one. The builder's item data already carries both languages, so
 * it now writes both.
 *
 * NULLABLE ON PURPOSE, with no backfill. `label`/`name` keep holding the
 * English value, and a reader in Portuguese falls back to them while the
 * Portuguese column is NULL. An existing row published from a Portuguese
 * builder holds Portuguese text in `label`; guessing which rows those are
 * from the text alone would be unreliable, so this migration leaves them for
 * an admin to fix in the builder's edit dialog. A republish in "Replace" mode
 * fills a missing Portuguese name from the item data, and leaves `label`
 * as it is.
 *
 * Transactional: two nullable `ADD COLUMN`s take no table rewrite and build
 * no index.
 */
export class AddStickerPortugueseNames1823600000000 implements MigrationInterface {
  name = 'AddStickerPortugueseNames1823600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "stickers" ADD "label_pt" character varying(80)`,
    );
    await queryRunner.query(
      `ALTER TABLE "sticker_packs" ADD "name_pt" character varying(80)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sticker_packs" DROP COLUMN "name_pt"`,
    );
    await queryRunner.query(`ALTER TABLE "stickers" DROP COLUMN "label_pt"`);
  }
}
