// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCommunitySpaceRequests1821700200000 implements MigrationInterface {
  name = 'AddCommunitySpaceRequests1821700200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "community_space_request_status_enum" AS ENUM (
        'open', 'approved', 'declined', 'withdrawn'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "community_space_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "community_id" uuid NOT NULL,
        "requested_by_user_id" uuid NOT NULL,
        "note" character varying(500),
        "status" "community_space_request_status_enum" NOT NULL DEFAULT 'open',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "decided_at" TIMESTAMP WITH TIME ZONE,
        "decided_by_user_id" uuid,
        "decline_reason" character varying(300),
        CONSTRAINT "PK_community_space_requests" PRIMARY KEY ("id"),
        CONSTRAINT "FK_community_space_requests_community" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_community_space_requests_requested_by" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_community_space_requests_decided_by" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_community_space_requests_community_id" ON "community_space_requests" ("community_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_space_requests_requested_by_user_id" ON "community_space_requests" ("requested_by_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_space_requests_decided_by_user_id" ON "community_space_requests" ("decided_by_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_community_space_requests_status" ON "community_space_requests" ("status")`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_community_space_requests_open"
        ON "community_space_requests" ("community_id")
        WHERE "status" = 'open'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "community_space_requests"`);
    await queryRunner.query(`DROP TYPE "community_space_request_status_enum"`);
  }
}
