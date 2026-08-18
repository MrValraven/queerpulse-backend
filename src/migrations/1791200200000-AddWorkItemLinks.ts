import { MigrationInterface, QueryRunner } from 'typeorm';

// A work item can carry up to 2 links (enforced by `WorkLinkDto`'s
// `@ArrayMaxSize(2)`, not at the DB level): either an in-app cross-reference
// (`{ kind: 'ref', entity, slug }`, e.g. a community or event this work item
// points at) or an arbitrary external URL (`{ kind: 'external', href }`). No
// GIN index — `links` is never queried/filtered on, only read back with its
// owning row.
export class AddWorkItemLinks1791200200000 implements MigrationInterface {
  name = 'AddWorkItemLinks1791200200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "work_items" ADD COLUMN "links" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "work_items" DROP COLUMN "links"`);
  }
}
