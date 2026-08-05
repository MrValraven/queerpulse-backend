// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P2-11 Collections: member-named groupings of saved items.
 *
 * `collection` is the folder (owner-scoped, optional emoji/cover). `collection_item`
 * is the join — one row per saved subject filed into a collection, polymorphic
 * `(subject_kind, subject_id)` exactly like `saved_item`, so an item is hydrated
 * back into its presentational snapshot from the owner's matching `saved_item`
 * on read (no second copy of the snapshot). `subject_kind` is a plain varchar
 * (not the `saved_item_subject_type_enum`) so collections never need an enum
 * migration when a new saveable kind is added.
 *
 * Both tables are brand-new, so their indexes are created inline as plain
 * `CREATE INDEX` alongside `CREATE TABLE` (no `CONCURRENTLY` — nothing is reading
 * them yet). `collection_item.collection_id` FKs `collection` with
 * `ON DELETE CASCADE` so deleting a collection drops its rows; `collection.owner_id`
 * FKs `users` with `ON DELETE CASCADE` so account erasure cleans up.
 */
export class CreateCollections1786000100000 implements MigrationInterface {
  name = 'CreateCollections1786000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "collection" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "owner_id" uuid NOT NULL,
        "name" character varying NOT NULL,
        "emoji" character varying,
        "cover" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_collection" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_collection_owner_id" ON "collection" ("owner_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "collection" ADD CONSTRAINT "FK_collection_owner_id"
        FOREIGN KEY ("owner_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "collection_item" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "collection_id" uuid NOT NULL,
        "subject_kind" character varying NOT NULL,
        "subject_id" character varying NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_collection_item" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_collection_item_subject" UNIQUE ("collection_id", "subject_kind", "subject_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_collection_item_collection_id" ON "collection_item" ("collection_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "collection_item" ADD CONSTRAINT "FK_collection_item_collection_id"
        FOREIGN KEY ("collection_id") REFERENCES "collection"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "collection_item" DROP CONSTRAINT "FK_collection_item_collection_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_collection_item_collection_id"`);
    await queryRunner.query(`DROP TABLE "collection_item"`);
    await queryRunner.query(
      `ALTER TABLE "collection" DROP CONSTRAINT "FK_collection_owner_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_collection_owner_id"`);
    await queryRunner.query(`DROP TABLE "collection"`);
  }
}
