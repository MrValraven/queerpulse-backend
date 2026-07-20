import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVolunteering1782693500000 implements MigrationInterface {
  name = 'AddVolunteering1782693500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "volunteer_opportunities_cause_enum" AS ENUM('rights', 'health', 'youth', 'housing', 'arts')`,
    );
    await queryRunner.query(
      `CREATE TYPE "volunteer_opportunities_commit_enum" AS ENUM('low', 'medium')`,
    );
    await queryRunner.query(
      `CREATE TYPE "volunteer_opportunities_status_enum" AS ENUM('open', 'closed')`,
    );

    // `partner_id` is a nullable uuid column with NO FK constraint yet — the
    // `partners` table doesn't exist until Phase D, whose migration adds the
    // FK constraint (see `.superpowers/sdd/spec-phaseC-volunteering.md`).
    await queryRunner.query(`
      CREATE TABLE "volunteer_opportunities" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "org" character varying NOT NULL,
        "partner_id" uuid,
        "role" character varying NOT NULL,
        "cause" "volunteer_opportunities_cause_enum" NOT NULL,
        "commit" "volunteer_opportunities_commit_enum" NOT NULL,
        "time" character varying NOT NULL,
        "location" character varying NOT NULL,
        "skills" text array NOT NULL DEFAULT '{}',
        "desc" text NOT NULL,
        "detail" jsonb NOT NULL,
        "spots_total" integer NOT NULL,
        "apply_role" character varying NOT NULL,
        "poster_id" uuid NOT NULL,
        "status" "volunteer_opportunities_status_enum" NOT NULL DEFAULT 'open',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_volunteer_opportunities" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_volunteer_opportunities_slug" ON "volunteer_opportunities" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_volunteer_opportunities_partner_id" ON "volunteer_opportunities" ("partner_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_volunteer_opportunities_poster_id" ON "volunteer_opportunities" ("poster_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "volunteer_opportunity_team" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "opportunity_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        CONSTRAINT "PK_volunteer_opportunity_team" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_volunteer_opportunity_team" UNIQUE ("opportunity_id", "user_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_volunteer_opportunity_team_opportunity_id" ON "volunteer_opportunity_team" ("opportunity_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_volunteer_opportunity_team_user_id" ON "volunteer_opportunity_team" ("user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "volunteer_signups" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "opportunity_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_volunteer_signups" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_volunteer_signups" UNIQUE ("opportunity_id", "user_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_volunteer_signups_opportunity_id" ON "volunteer_signups" ("opportunity_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_volunteer_signups_user_id" ON "volunteer_signups" ("user_id")`,
    );

    // Foreign keys. `partner_id` is deliberately excluded — see the comment
    // above `volunteer_opportunities` and the Phase C spec.
    await queryRunner.query(
      `ALTER TABLE "volunteer_opportunities" ADD CONSTRAINT "FK_volunteer_opportunities_poster_id" FOREIGN KEY ("poster_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_opportunity_team" ADD CONSTRAINT "FK_volunteer_opportunity_team_opportunity_id" FOREIGN KEY ("opportunity_id") REFERENCES "volunteer_opportunities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_opportunity_team" ADD CONSTRAINT "FK_volunteer_opportunity_team_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" ADD CONSTRAINT "FK_volunteer_signups_opportunity_id" FOREIGN KEY ("opportunity_id") REFERENCES "volunteer_opportunities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" ADD CONSTRAINT "FK_volunteer_signups_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" DROP CONSTRAINT "FK_volunteer_signups_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_signups" DROP CONSTRAINT "FK_volunteer_signups_opportunity_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_opportunity_team" DROP CONSTRAINT "FK_volunteer_opportunity_team_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_opportunity_team" DROP CONSTRAINT "FK_volunteer_opportunity_team_opportunity_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "volunteer_opportunities" DROP CONSTRAINT "FK_volunteer_opportunities_poster_id"`,
    );

    await queryRunner.query(`DROP TABLE "volunteer_signups"`);
    await queryRunner.query(`DROP TABLE "volunteer_opportunity_team"`);
    await queryRunner.query(`DROP TABLE "volunteer_opportunities"`);

    await queryRunner.query(`DROP TYPE "volunteer_opportunities_status_enum"`);
    await queryRunner.query(`DROP TYPE "volunteer_opportunities_commit_enum"`);
    await queryRunner.query(`DROP TYPE "volunteer_opportunities_cause_enum"`);
  }
}
