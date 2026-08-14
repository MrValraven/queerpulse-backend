import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class AddMediaCrops1789400000000 implements MigrationInterface {
  name = 'AddMediaCrops1789400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'media_crops',
        columns: [
          { name: 'storage_key', type: 'varchar', isPrimary: true },
          { name: 'owner_id', type: 'uuid', isNullable: false },
          { name: 'crop', type: 'jsonb', isNullable: false },
          {
            name: 'created_at',
            type: 'timestamptz',
            default: 'now()',
            isNullable: false,
          },
          {
            name: 'updated_at',
            type: 'timestamptz',
            default: 'now()',
            isNullable: false,
          },
        ],
      }),
      true,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_media_crops_owner_id" ON "media_crops" ("owner_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_media_crops_owner_id"`);
    await queryRunner.dropTable('media_crops');
  }
}
