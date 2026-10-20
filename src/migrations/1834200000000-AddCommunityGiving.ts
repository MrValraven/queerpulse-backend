// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A community's giving section ("Support" in the UI): the ways a visitor can
 * send the community money or help, kept outside QueerPulse. Money never
 * passes through the platform; these rows only point at where it goes.
 *
 * `community_giving_methods` holds up to 8 rows per community (enforced by
 * `CommunityGivingService`), ordered by `position`. The whole set is replaced
 * in one transaction on every save, so `created_at` doubles as "last changed".
 * The community FK cascades: the section has no meaning without the community.
 * No actor column: who changed the section lives in `community_governance_log`.
 *
 * `communities.giving_intro` is the one or two lines above the methods.
 *
 * The index builds on an empty table, so the file stays inside one transaction.
 */
export class AddCommunityGiving1834200000000 implements MigrationInterface {
  name = 'AddCommunityGiving1834200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "community_giving_kind" AS ENUM ('link', 'mbway', 'iban')
    `);
    await queryRunner.query(`
      CREATE TABLE "community_giving_methods" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "community_id" uuid NOT NULL,
        "kind" "community_giving_kind" NOT NULL,
        "label" character varying(60),
        "value" character varying(500) NOT NULL,
        "note" character varying(160),
        "position" integer NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_community_giving_methods" PRIMARY KEY ("id"),
        CONSTRAINT "FK_community_giving_methods_community" FOREIGN KEY ("community_id")
          REFERENCES "communities"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_community_giving_methods_community_id"
        ON "community_giving_methods" ("community_id")
    `);
    await queryRunner.query(`
      ALTER TABLE "communities" ADD "giving_intro" character varying(400)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "giving_intro"`,
    );
    await queryRunner.query(`DROP TABLE "community_giving_methods"`);
    await queryRunner.query(`DROP TYPE "community_giving_kind"`);
  }
}
