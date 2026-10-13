// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio v2 (`QUEERPULSE-STUDIO-V2-DESIGN-2026-10-13.md`, section 5): member
 * playlists and their entries.
 *
 * `FK_studio_playlists_credit_subprofile` sets the credit null when the
 * persona is deleted and cascades on update, so an unlink re-key
 * (`issueFreshPersonaId`) carries it to the fresh id until the unlink hook
 * clears it in the same transaction. `is_credited_to_persona` survives the
 * null, so a playlist whose persona went away by any path reads as a broken
 * persona credit (private), and `CHK_studio_playlists_persona_credit` keeps
 * the flag honest.
 *
 * `FK_studio_playlist_tracks_track` cascades on delete and sets null on
 * update: an unlink gives every track of the persona a fresh id, and the
 * entry stays as an unavailable row for the owner. Without the update action
 * the v1 re-key `UPDATE "studio_tracks" SET "id" = ...` would fail on any
 * track someone had added to a playlist.
 *
 * `UQ_studio_playlist_tracks_playlist_position` is DEFERRABLE INITIALLY
 * IMMEDIATE: a reorder or a renumber rewrites positions in one statement.
 * `created_at` and `updated_at` hold milliseconds, since `updated_at` is a
 * keyset cursor read back through JS `Date`s.
 *
 * Both tables are new and empty, so every index builds inside the migration
 * transaction. The `studio_playlist` saved kind is added by
 * `AddStudioV2EnumValues1831500200000`, outside a transaction.
 */
export class AddStudioPlaylists1831500000000 implements MigrationInterface {
  name = 'AddStudioPlaylists1831500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "studio_playlists_visibility_enum" AS ENUM ('public', 'connections', 'private')`,
    );
    await queryRunner.query(`
      CREATE TABLE "studio_playlists" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "name" character varying(80) NOT NULL,
        "description" text,
        "visibility" "studio_playlists_visibility_enum" NOT NULL DEFAULT 'private',
        "credit_subprofile_id" uuid,
        "is_credited_to_persona" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_playlists" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_studio_playlists_persona_credit" CHECK ("credit_subprofile_id" IS NULL OR "is_credited_to_persona"),
        CONSTRAINT "FK_studio_playlists_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_studio_playlists_credit_subprofile" FOREIGN KEY ("credit_subprofile_id") REFERENCES "subprofiles"("id") ON DELETE SET NULL ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_playlists_user_updated_at" ON "studio_playlists" ("user_id", "updated_at" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_playlists_credit_subprofile_id" ON "studio_playlists" ("credit_subprofile_id") WHERE "credit_subprofile_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_playlists_public_updated_at" ON "studio_playlists" ("visibility", "updated_at" DESC, "id" DESC) WHERE "visibility" = 'public'`,
    );
    await queryRunner.query(`
      CREATE TABLE "studio_playlist_tracks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "playlist_id" uuid NOT NULL,
        "track_id" uuid,
        "position" smallint NOT NULL,
        "added_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_playlist_tracks" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_studio_playlist_tracks_playlist_position" UNIQUE ("playlist_id", "position") DEFERRABLE INITIALLY IMMEDIATE,
        CONSTRAINT "UQ_studio_playlist_tracks_playlist_track" UNIQUE ("playlist_id", "track_id"),
        CONSTRAINT "CHK_studio_playlist_tracks_position" CHECK ("position" >= 1),
        CONSTRAINT "FK_studio_playlist_tracks_playlist" FOREIGN KEY ("playlist_id") REFERENCES "studio_playlists"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_studio_playlist_tracks_track" FOREIGN KEY ("track_id") REFERENCES "studio_tracks"("id") ON DELETE CASCADE ON UPDATE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_playlist_tracks_track_id" ON "studio_playlist_tracks" ("track_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "studio_playlist_tracks"`);
    await queryRunner.query(`DROP TABLE "studio_playlists"`);
    await queryRunner.query(`DROP TYPE "studio_playlists_visibility_enum"`);
  }
}
