import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives `topics` an `archived_at` timestamp so the operating team can retire a
 * topic without destroying it (SOC-01).
 *
 * WHY A TIMESTAMP RATHER THAN A BOOLEAN. It is mapped as TypeORM's
 * `@DeleteDateColumn` on `content/entities/topic.entity.ts`, which makes every
 * existing read exclude archived rows on its own: the directory list, the
 * topic detail lookup, the related-topics panel and the global search fan-out
 * all run through `find`/`createQueryBuilder` on that entity, and TypeORM
 * appends `archived_at IS NULL` to a select unless it is asked for deleted
 * rows. A boolean would have needed the same predicate hand-written at four
 * call sites, with a fifth one waiting to be forgotten.
 *
 * ARCHIVE IS NOT DELETE. Archiving keeps the row, its posts and its followers,
 * so restoring is one call and nothing is lost. `DELETE /admin/topics/:id`
 * remains available for a topic created in error, and cascades to its posts.
 *
 * NO INDEX. The directory is an operating-curated list of tens of rows read in
 * full by `GET /topics`, so the predicate rides along on a sequential scan. An
 * index here would cost writes and save nothing measurable.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class AddTopicArchivedAt1794700000000 implements MigrationInterface {
  name = 'AddTopicArchivedAt1794700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "topics" ADD "archived_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "topics" DROP COLUMN "archived_at"`);
  }
}
