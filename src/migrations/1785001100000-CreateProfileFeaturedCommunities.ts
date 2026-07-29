import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateProfileFeaturedCommunities1785001100000
  implements MigrationInterface
{
  name = 'CreateProfileFeaturedCommunities1785001100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'profile_featured_communities',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'uuid_generate_v4()' },
          { name: 'user_id', type: 'uuid' },
          { name: 'community_id', type: 'uuid' },
          { name: 'position', type: 'int' },
        ],
        uniques: [
          {
            name: 'UQ_profile_featured_communities',
            columnNames: ['user_id', 'community_id'],
          },
        ],
      }),
      true,
    );
    await queryRunner.createIndex(
      'profile_featured_communities',
      new TableIndex({
        name: 'IDX_profile_featured_communities_user_id',
        columnNames: ['user_id'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('profile_featured_communities');
  }
}
