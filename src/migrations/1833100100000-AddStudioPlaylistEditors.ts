// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Collaborative playlists
 * (`QUEERPULSE-STUDIO-COLLAB-PLAYLISTS-DESIGN-2026-10-14.md`, section 2).
 *
 * `studio_playlist_editors` holds one row per member per playlist
 * (`UQ_studio_playlist_editors_playlist_user`); a re-invite reuses it. The
 * playlist and the member cascade, the inviter sets null.
 * `CHK_studio_playlist_editors_persona_source` keeps persona co-owner picks
 * out of `invited` and `declined`, since they never answer an invitation.
 * `IDX_studio_playlist_editors_user_status` serves "playlists I edit" and
 * "my invitations". The owner is kept out of the table by the service.
 *
 * `studio_playlist_tracks.added_by_user_id` is nullable with no default, so
 * adding it rewrites nothing; existing entries read as added by nobody. The
 * foreign key sets null on account erasure, and the partial index serves
 * that erasure and the "added by" clears.
 *
 * The table is new and empty and `studio_playlist_tracks` is small (Studio
 * v2), so every index builds inside the migration transaction.
 */
export class AddStudioPlaylistEditors1833100100000 implements MigrationInterface {
  name = 'AddStudioPlaylistEditors1833100100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "studio_playlist_editors_source_enum" AS ENUM ('member_invite', 'persona_co_owner')`,
    );
    await queryRunner.query(
      `CREATE TYPE "studio_playlist_editors_status_enum" AS ENUM ('invited', 'active', 'declined', 'revoked', 'left')`,
    );
    await queryRunner.query(`
      CREATE TABLE "studio_playlist_editors" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "playlist_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "invited_by_user_id" uuid,
        "source" "studio_playlist_editors_source_enum" NOT NULL,
        "status" "studio_playlist_editors_status_enum" NOT NULL DEFAULT 'invited',
        "invited_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        "accepted_at" TIMESTAMP(3) WITH TIME ZONE,
        "ended_at" TIMESTAMP(3) WITH TIME ZONE,
        CONSTRAINT "PK_studio_playlist_editors" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_studio_playlist_editors_playlist_user" UNIQUE ("playlist_id", "user_id"),
        CONSTRAINT "CHK_studio_playlist_editors_persona_source" CHECK ("source" <> 'persona_co_owner' OR "status" NOT IN ('invited', 'declined')),
        CONSTRAINT "FK_studio_playlist_editors_playlist" FOREIGN KEY ("playlist_id") REFERENCES "studio_playlists"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_studio_playlist_editors_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_studio_playlist_editors_invited_by" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_playlist_editors_user_status" ON "studio_playlist_editors" ("user_id", "status")`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_playlist_tracks" ADD COLUMN "added_by_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_playlist_tracks" ADD CONSTRAINT "FK_studio_playlist_tracks_added_by" FOREIGN KEY ("added_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_playlist_tracks_added_by_user_id" ON "studio_playlist_tracks" ("added_by_user_id") WHERE "added_by_user_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_studio_playlist_tracks_added_by_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_playlist_tracks" DROP CONSTRAINT "FK_studio_playlist_tracks_added_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_playlist_tracks" DROP COLUMN "added_by_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "studio_playlist_editors"`);
    await queryRunner.query(`DROP TYPE "studio_playlist_editors_status_enum"`);
    await queryRunner.query(`DROP TYPE "studio_playlist_editors_source_enum"`);
  }
}
