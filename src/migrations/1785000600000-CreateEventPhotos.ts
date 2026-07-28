import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateEventPhotos1785000600000 implements MigrationInterface {
  name = 'CreateEventPhotos1785000600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'event_photos',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'uuid_generate_v4()' },
          { name: 'event_id', type: 'uuid' },
          { name: 'storage_key', type: 'text' },
          { name: 'uploader_id', type: 'uuid' },
          { name: 'caption', type: 'varchar', isNullable: true },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
        ],
        uniques: [
          { name: 'UQ_event_photos_storage_key', columnNames: ['storage_key'] },
        ],
      }),
      true,
    );
    await queryRunner.createIndex(
      'event_photos',
      new TableIndex({
        name: 'IDX_event_photos_event_id',
        columnNames: ['event_id'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('event_photos');
  }
}
