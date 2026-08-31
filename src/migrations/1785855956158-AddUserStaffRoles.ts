import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
} from 'typeorm';

/**
 * Adds `user_staff_roles` — additive functional grants (e.g. `magazine_editor`,
 * `magazine_writer`) held on top of a member's account tier (`users.role`).
 * `role` is a plain varchar validated at the app layer against the
 * `STAFF_ROLES` registry, so adding a future role needs no migration.
 * `granted_by` is `ON DELETE SET NULL` so deleting the granting admin keeps
 * the audit-ish row rather than cascading it away.
 */
export class AddUserStaffRoles1785855956158 implements MigrationInterface {
  name = 'AddUserStaffRoles1785855956158';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'user_staff_roles',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'uuid_generate_v4()',
          },
          { name: 'user_id', type: 'uuid' },
          { name: 'role', type: 'varchar' },
          { name: 'granted_by', type: 'uuid', isNullable: true },
          { name: 'granted_at', type: 'timestamptz', default: 'now()' },
        ],
        uniques: [
          {
            name: 'uq_user_staff_roles_user_role',
            columnNames: ['user_id', 'role'],
          },
        ],
        indices: [
          { name: 'idx_user_staff_roles_user', columnNames: ['user_id'] },
        ],
      }),
    );
    await queryRunner.createForeignKey(
      'user_staff_roles',
      new TableForeignKey({
        columnNames: ['user_id'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      }),
    );
    await queryRunner.createForeignKey(
      'user_staff_roles',
      new TableForeignKey({
        columnNames: ['granted_by'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'SET NULL',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('user_staff_roles');
  }
}
