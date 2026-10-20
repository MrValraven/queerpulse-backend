// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

const CONTENT_WARNING_IDS_SQL = `ARRAY['medical', 'violence', 'substances', 'family-rejection', 'sexual-content', 'self-harm', 'housing-loss', 'police']::text[]`;

/**
 * Studio safety and moderation (spec section 3): the track's content
 * warnings, explicit lock and withheld stamp; the copyright claims table;
 * the "Ask before warned tracks" preference.
 *
 * NO ARTIST MEMBER COLUMN on the claims table. The claimant is stored (a
 * claim is filed in a member's own name); track ownership is checked at call
 * time and stored nowhere, so a counter-notice never ties a persona to its
 * member.
 *
 * Both claim foreign keys to Studio rows cascade on update: a persona unlink
 * gives every release and track a fresh id (`subprofile-unlink-rekey.ts`),
 * and a plain key would make that unlink fail for a claimed track. The
 * claimant key cascades on delete; the account erasure restores what the
 * claimant alone held before the user row goes.
 *
 * The track title and artist name at filing are kept on the claim. A
 * persona unlink sets `is_severed` on the claims about its tracks, and from
 * then on the claimant view and the data export serve those two names with
 * no track, release or persona reference, so the claimant never sees the
 * claim under the pseudonymous persona. Staff and owners keep the cascaded
 * ids.
 *
 * The four track checks scan `studio_tracks` once while adding the columns
 * with constant defaults, which every existing row passes. The claims table
 * is new and empty, so its indexes build inside the transaction. Runs after
 * `AddStudioSafetyEnumValues1834000000000`, which commits no label this one
 * uses (the claim types are new types created here).
 */
export class AddStudioSafety1834000100000 implements MigrationInterface {
  name = 'AddStudioSafety1834000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "studio_tracks"
        ADD COLUMN "content_warnings" text[] NOT NULL DEFAULT '{}',
        ADD COLUMN "staff_content_warnings" text[] NOT NULL DEFAULT '{}',
        ADD COLUMN "explicit_locked_at" TIMESTAMP(3) WITH TIME ZONE,
        ADD COLUMN "withheld_at" TIMESTAMP(3) WITH TIME ZONE
    `);
    await queryRunner.query(`
      ALTER TABLE "studio_tracks"
        ADD CONSTRAINT "CHK_studio_tracks_content_warnings"
          CHECK (cardinality("content_warnings") <= 8 AND "content_warnings" <@ ${CONTENT_WARNING_IDS_SQL}),
        ADD CONSTRAINT "CHK_studio_tracks_staff_content_warnings"
          CHECK (cardinality("staff_content_warnings") <= 8 AND "staff_content_warnings" <@ ${CONTENT_WARNING_IDS_SQL}),
        ADD CONSTRAINT "CHK_studio_tracks_explicit_locked"
          CHECK ("explicit_locked_at" IS NULL OR "is_explicit")
    `);
    await queryRunner.query(
      `CREATE TYPE "studio_copyright_claims_status_enum" AS ENUM ('submitted', 'accepted', 'declined', 'countered', 'upheld', 'rejected', 'withdrawn')`,
    );
    await queryRunner.query(
      `CREATE TYPE "studio_copyright_claims_claimant_role_enum" AS ENUM ('rights_holder', 'authorised')`,
    );
    await queryRunner.query(`
      CREATE TABLE "studio_copyright_claims" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "track_id" uuid NOT NULL,
        "release_id" uuid NOT NULL,
        "claimant_id" uuid NOT NULL,
        "claimant_role" "studio_copyright_claims_claimant_role_enum" NOT NULL,
        "original_work" character varying(200) NOT NULL,
        "original_link" character varying(500),
        "details" character varying(2000) NOT NULL,
        "good_faith_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
        "status" "studio_copyright_claims_status_enum" NOT NULL DEFAULT 'submitted',
        "counter_note" character varying(2000),
        "countered_at" TIMESTAMP(3) WITH TIME ZONE,
        "claimant_reply" character varying(1000),
        "replied_at" TIMESTAMP(3) WITH TIME ZONE,
        "staff_note" character varying(1000),
        "decided_by_id" uuid,
        "accepted_at" TIMESTAMP(3) WITH TIME ZONE,
        "decided_at" TIMESTAMP(3) WITH TIME ZONE,
        "track_title_at_filing" character varying(120) NOT NULL,
        "artist_name_at_filing" character varying(120) NOT NULL,
        "is_severed" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_copyright_claims" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_studio_copyright_claims_counter_pair" CHECK (("counter_note" IS NULL) = ("countered_at" IS NULL)),
        CONSTRAINT "CHK_studio_copyright_claims_reply_pair" CHECK (("claimant_reply" IS NULL) = ("replied_at" IS NULL)),
        CONSTRAINT "CHK_studio_copyright_claims_decided" CHECK ("status" NOT IN ('declined', 'upheld', 'rejected') OR "decided_at" IS NOT NULL),
        CONSTRAINT "CHK_studio_copyright_claims_accepted" CHECK ("status" NOT IN ('accepted', 'countered', 'upheld', 'rejected') OR "accepted_at" IS NOT NULL),
        CONSTRAINT "CHK_studio_copyright_claims_staff_note" CHECK ("status" NOT IN ('declined', 'upheld', 'rejected') OR "staff_note" IS NOT NULL),
        CONSTRAINT "CHK_studio_copyright_claims_original_link" CHECK ("original_link" IS NULL OR "original_link" ~* '^https?://'),
        CONSTRAINT "FK_studio_copyright_claims_track" FOREIGN KEY ("track_id") REFERENCES "studio_tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_copyright_claims_release" FOREIGN KEY ("release_id") REFERENCES "studio_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_copyright_claims_claimant" FOREIGN KEY ("claimant_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_studio_copyright_claims_decided_by" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_studio_copyright_claims_live_track_claimant" ON "studio_copyright_claims" ("track_id", "claimant_id") WHERE "status" IN ('submitted', 'accepted', 'countered')`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_copyright_claims_status_created_at" ON "studio_copyright_claims" ("status", "created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_copyright_claims_claimant_created_at" ON "studio_copyright_claims" ("claimant_id", "created_at" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_copyright_claims_track" ON "studio_copyright_claims" ("track_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_copyright_claims_release" ON "studio_copyright_claims" ("release_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "member_preferences" ADD COLUMN "studio_ask_before_warnings" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "member_preferences" DROP COLUMN "studio_ask_before_warnings"`,
    );
    await queryRunner.query(`DROP TABLE "studio_copyright_claims"`);
    await queryRunner.query(
      `DROP TYPE "studio_copyright_claims_claimant_role_enum"`,
    );
    await queryRunner.query(`DROP TYPE "studio_copyright_claims_status_enum"`);
    await queryRunner.query(`
      ALTER TABLE "studio_tracks"
        DROP CONSTRAINT "CHK_studio_tracks_explicit_locked",
        DROP CONSTRAINT "CHK_studio_tracks_staff_content_warnings",
        DROP CONSTRAINT "CHK_studio_tracks_content_warnings",
        DROP COLUMN "withheld_at",
        DROP COLUMN "explicit_locked_at",
        DROP COLUMN "staff_content_warnings",
        DROP COLUMN "content_warnings"
    `);
  }
}
