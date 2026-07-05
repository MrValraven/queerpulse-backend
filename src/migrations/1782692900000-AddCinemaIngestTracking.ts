import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCinemaIngestTracking1782692900000
  implements MigrationInterface
{
  name = 'AddCinemaIngestTracking1782692900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "cinema_titles" ADD "last_ingest_event_at" timestamptz`,
    );
    // Backfill in-flight titles so the reconciliation sweep has a stale-clock
    // baseline immediately after deploy. updated_at is the best proxy at
    // migration time; from here on the column is stamped on every ingest
    // transition (see CinemaService), independent of view-count bumps.
    await queryRunner.query(
      `UPDATE "cinema_titles" SET "last_ingest_event_at" = "updated_at" ` +
        `WHERE "status" IN ('awaiting_upload', 'processing') ` +
        `OR "pending_mux_upload_id" IS NOT NULL ` +
        `OR "pending_mux_asset_id" IS NOT NULL`,
    );
    // The reconciliation query filters mid-ingest titles by staleness; keep
    // that scan cheap the same way the status/published_at lookups are indexed.
    await queryRunner.query(
      `CREATE INDEX "IDX_cinema_titles_last_ingest_event_at" ON "cinema_titles" ("last_ingest_event_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_cinema_titles_last_ingest_event_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cinema_titles" DROP COLUMN "last_ingest_event_at"`,
    );
  }
}
