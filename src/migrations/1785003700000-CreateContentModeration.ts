import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The shared content-moderation state table (see `ContentModeration` entity).
 *
 * Backs the fix for the P3 audit item "`hide_content`/`remove_content` mod
 * actions don't touch content": a moderator takedown now writes one row here,
 * keyed by `(subject_type, subject_id)` — the same pair `reports` carries — and
 * content read paths consult it. A shared table rather than columns on the ~15
 * content tables the report taxonomy targets: one migration, no touch to the
 * content schema, and a takedown stays cleanly distinct from an author's own
 * soft-delete.
 *
 * `subject_type`/`subject_id` are `varchar` (not the reports enum) so this table
 * stays decoupled from that enum's lifecycle. The unique index on the pair
 * makes the service's upsert (`ON CONFLICT (subject_type, subject_id)`)
 * well-defined and lets read paths look a subject up by its natural key.
 */
export class CreateContentModeration1785003700000 implements MigrationInterface {
  name = 'CreateContentModeration1785003700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "content_moderation" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subject_type" character varying NOT NULL,
        "subject_id" character varying NOT NULL,
        "hidden_at" TIMESTAMP WITH TIME ZONE,
        "removed_at" TIMESTAMP WITH TIME ZONE,
        "moderated_by" uuid,
        "report_id" uuid,
        "reason_code" character varying,
        "note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_content_moderation" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_content_moderation_subject" ON "content_moderation" ("subject_type", "subject_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_content_moderation_subject"`);
    await queryRunner.query(`DROP TABLE "content_moderation"`);
  }
}
