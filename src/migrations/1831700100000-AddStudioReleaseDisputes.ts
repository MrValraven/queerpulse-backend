// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio open demo pages (`QUEERPULSE-STUDIO-OPEN-DEMO-PAGES-DESIGN-2026-10-13.md`,
 * section 5.1): an artist's dispute about a taken-down release.
 *
 * NO MEMBER COLUMN. Ownership of the persona is checked when the dispute is
 * filed and stored nowhere, so this table never tells staff who runs a
 * persona. `decided_by_id` names the staff member who decided and is set
 * null when that account goes.
 *
 * `FK_studio_release_disputes_release` cascades on delete (a deleted release
 * takes its disputes) and on update: a persona unlink gives every release a
 * fresh id (`issueFreshPersonaId`), and without the update action that
 * unlink would fail for any release with a dispute.
 *
 * `UQ_studio_release_disputes_open_release` keeps one open dispute per
 * release; the lifetime cap of 3 is checked in `StudioDisputesService` under
 * the release row lock. `CHK_studio_release_disputes_decision` ties the
 * reply and the decision time to a decided status. `created_at` holds
 * milliseconds because the staff list pages on it.
 *
 * The table is new and empty, so every index builds inside the migration
 * transaction.
 */
export class AddStudioReleaseDisputes1831700100000 implements MigrationInterface {
  name = 'AddStudioReleaseDisputes1831700100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "studio_release_disputes_status_enum" AS ENUM ('open', 'upheld', 'rejected')`,
    );
    await queryRunner.query(`
      CREATE TABLE "studio_release_disputes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "release_id" uuid NOT NULL,
        "note" character varying(1000) NOT NULL,
        "status" "studio_release_disputes_status_enum" NOT NULL DEFAULT 'open',
        "staff_reply" character varying(1000),
        "decided_by_id" uuid,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        "decided_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_studio_release_disputes" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_studio_release_disputes_decision" CHECK (
          ("status" = 'open' AND "decided_at" IS NULL AND "staff_reply" IS NULL)
          OR ("status" <> 'open' AND "decided_at" IS NOT NULL AND "staff_reply" IS NOT NULL)
        ),
        CONSTRAINT "FK_studio_release_disputes_release" FOREIGN KEY ("release_id") REFERENCES "studio_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_release_disputes_decided_by" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_studio_release_disputes_open_release" ON "studio_release_disputes" ("release_id") WHERE "status" = 'open'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_release_disputes_release_created_at" ON "studio_release_disputes" ("release_id", "created_at" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_release_disputes_status_created_at" ON "studio_release_disputes" ("status", "created_at" DESC, "id" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "studio_release_disputes"`);
    await queryRunner.query(`DROP TYPE "studio_release_disputes_status_enum"`);
  }
}
