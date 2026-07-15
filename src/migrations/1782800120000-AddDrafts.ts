import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDrafts1782800120000 implements MigrationInterface {
  name = 'AddDrafts1782800120000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `id` is caller-supplied (the frontend mints its own opaque draft id
    // client-side, e.g. `invite-${Date.now()}`) — not a generated uuid.
    // Primary key is the composite `(user_id, id)` so uniqueness is scoped to
    // the owning user: two different users can never collide on the same
    // client-chosen id, and every lookup is already user-scoped anyway.
    await queryRunner.query(`
      CREATE TABLE "draft" (
        "id" character varying NOT NULL,
        "user_id" uuid NOT NULL,
        "kind" character varying NOT NULL,
        "payload" jsonb NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_draft" PRIMARY KEY ("user_id", "id")
      )
    `);
    // Supports the hot path: `GET /me/drafts?page=` — filter by user then
    // sort newest-edited-first.
    await queryRunner.query(
      `CREATE INDEX "IDX_draft_user_id_updated_at" ON "draft" ("user_id", "updated_at" DESC)`,
    );
    await queryRunner.query(`
      ALTER TABLE "draft" ADD CONSTRAINT "FK_draft_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "draft" DROP CONSTRAINT "FK_draft_user_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_draft_user_id_updated_at"`);
    await queryRunner.query(`DROP TABLE "draft"`);
  }
}
