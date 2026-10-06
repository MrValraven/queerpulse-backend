// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-447: a persona that goes unlinked gets a fresh id, and so does each of
 * its items.
 *
 * `SubprofilesService.update` re-keys the persona row inside the unlink
 * transaction (`issueFreshPersonaId`), then gives every item of the persona a
 * new id, so neither the persona id nor an item id the named persona exposed
 * resolves anywhere afterwards. Each is a single `UPDATE ... SET "id"`, which
 * Postgres only allows while every foreign key to the re-keyed column carries
 * `ON UPDATE CASCADE`. Every one of them was `ON UPDATE NO ACTION`.
 *
 * This re-creates the 13 foreign keys to `subprofiles.id` and the 2 to
 * `subprofile_items.id` with `ON UPDATE CASCADE`, keeping each one's name,
 * column and `ON DELETE` action. A name that drifted on a database fails
 * its `DROP CONSTRAINT`. The last step reads the catalog and fails the
 * migration when any foreign key to either table still lacks the cascade,
 * which is how a key missing from this list shows up at deploy. Keys added
 * by later migrations are outside both checks: `persona-foreign-keys.spec.ts`
 * compares this list with the foreign keys every migration declares, so a
 * new one fails the unit suite until it cascades too.
 *
 * `down` puts every key back to `ON UPDATE NO ACTION`.
 */

/** A foreign key the unlink re-key depends on. */
export interface PersonaForeignKey {
  table: string;
  constraintName: string;
  column: string;
  references: 'subprofiles' | 'subprofile_items';
  onDelete: 'CASCADE' | 'SET NULL';
}

/** Every foreign key to `subprofiles.id` and `subprofile_items.id`. */
export const PERSONA_FOREIGN_KEYS: ReadonlyArray<PersonaForeignKey> = [
  {
    table: 'subprofile_items',
    constraintName: 'FK_subprofile_items_subprofile_id',
    column: 'subprofile_id',
    references: 'subprofiles',
    onDelete: 'CASCADE',
  },
  {
    table: 'subprofile_social_links',
    constraintName: 'FK_subprofile_social_links_subprofile_id',
    column: 'subprofile_id',
    references: 'subprofiles',
    onDelete: 'CASCADE',
  },
  {
    table: 'subprofile_endorsements',
    constraintName: 'FK_subprofile_endorsements_subprofile_id',
    column: 'subprofile_id',
    references: 'subprofiles',
    onDelete: 'CASCADE',
  },
  {
    table: 'subprofile_followers',
    constraintName: 'FK_subprofile_followers_subprofile_id',
    column: 'subprofile_id',
    references: 'subprofiles',
    onDelete: 'CASCADE',
  },
  {
    table: 'subprofile_affiliations',
    constraintName: 'FK_subprofile_affiliations_subprofile_id',
    column: 'subprofile_id',
    references: 'subprofiles',
    onDelete: 'CASCADE',
  },
  {
    table: 'subprofile_members',
    constraintName: 'FK_subprofile_members_subprofile',
    column: 'subprofile_id',
    references: 'subprofiles',
    onDelete: 'CASCADE',
  },
  {
    table: 'subprofile_invites',
    constraintName: 'FK_subprofile_invites_subprofile',
    column: 'subprofile_id',
    references: 'subprofiles',
    onDelete: 'CASCADE',
  },
  {
    table: 'subprofile_address_history',
    constraintName: 'FK_subprofile_address_history_subprofile',
    column: 'subprofile_id',
    references: 'subprofiles',
    onDelete: 'CASCADE',
  },
  {
    table: 'subprofile_feeds',
    constraintName: 'FK_subprofile_feeds_subprofile',
    column: 'subprofile_id',
    references: 'subprofiles',
    onDelete: 'CASCADE',
  },
  {
    table: 'subprofile_feed_entries',
    constraintName: 'FK_subprofile_feed_entries_subprofile',
    column: 'subprofile_id',
    references: 'subprofiles',
    onDelete: 'CASCADE',
  },
  {
    table: 'handles',
    constraintName: 'FK_handles_subprofile_id',
    column: 'subprofile_id',
    references: 'subprofiles',
    onDelete: 'CASCADE',
  },
  {
    table: 'handle_history',
    constraintName: 'FK_handle_history_previous_owner_subprofile_id',
    column: 'previous_owner_subprofile_id',
    references: 'subprofiles',
    onDelete: 'SET NULL',
  },
  {
    table: 'identities',
    constraintName: 'FK_identities_subprofile',
    column: 'subprofile_id',
    references: 'subprofiles',
    onDelete: 'CASCADE',
  },
  {
    table: 'subprofile_item_revisions',
    constraintName: 'FK_subprofile_item_revisions_item_id',
    column: 'item_id',
    references: 'subprofile_items',
    onDelete: 'CASCADE',
  },
  {
    table: 'subprofile_feed_entries',
    constraintName: 'FK_subprofile_feed_entries_item',
    column: 'item_id',
    references: 'subprofile_items',
    onDelete: 'SET NULL',
  },
];

export class CascadePersonaIdUpdates1830060000000 implements MigrationInterface {
  name = 'CascadePersonaIdUpdates1830060000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const foreignKey of PERSONA_FOREIGN_KEYS) {
      await this.recreate(queryRunner, foreignKey, 'CASCADE');
    }
    await queryRunner.query(`
      DO $$
      DECLARE
        keys_without_cascade text;
      BEGIN
        SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ')
          INTO keys_without_cascade
          FROM pg_constraint
         WHERE contype = 'f'
           AND confrelid IN (
             '"subprofiles"'::regclass,
             '"subprofile_items"'::regclass
           )
           AND confupdtype <> 'c';
        IF keys_without_cascade IS NOT NULL THEN
          RAISE EXCEPTION
            'Foreign keys to subprofiles or subprofile_items without ON UPDATE CASCADE: %',
            keys_without_cascade;
        END IF;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const foreignKey of PERSONA_FOREIGN_KEYS) {
      await this.recreate(queryRunner, foreignKey, 'NO ACTION');
    }
  }

  private async recreate(
    queryRunner: QueryRunner,
    foreignKey: PersonaForeignKey,
    onUpdate: 'CASCADE' | 'NO ACTION',
  ): Promise<void> {
    const { table, constraintName, column, references, onDelete } = foreignKey;
    await queryRunner.query(
      `ALTER TABLE "${table}" DROP CONSTRAINT "${constraintName}"`,
    );
    await queryRunner.query(`
      ALTER TABLE "${table}" ADD CONSTRAINT "${constraintName}"
        FOREIGN KEY ("${column}") REFERENCES "${references}"("id")
        ON DELETE ${onDelete} ON UPDATE ${onUpdate}
    `);
  }
}
