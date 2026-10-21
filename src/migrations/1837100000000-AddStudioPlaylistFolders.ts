// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio playlist folders (Studio UI polish, PRD-11 folders).
 *
 * `studio_playlist_folders` holds a member's folders, ordered by
 * `position` (`IDX_studio_playlist_folders_user_position` serves the rail
 * read). `studio_playlist_folder_items` files one playlist in one of the
 * member's folders: the folder reference sits on this per-member row, since
 * the owner, each editor and everyone who saved a playlist file it on their
 * own. `UQ_studio_playlist_folder_items_user_playlist` keeps a playlist in
 * at most one folder per member and serves "where is this playlist".
 *
 * The folder, the playlist and the account cascade, so deleting a folder
 * puts its playlists back at the top level and an erased account leaves
 * nothing behind. `IDX_studio_playlist_folder_items_folder_id` and
 * `IDX_studio_playlist_folder_items_playlist_id` serve those cascades.
 *
 * Both tables are new and empty, so every index builds inside the migration
 * transaction.
 */
export class AddStudioPlaylistFolders1837100000000 implements MigrationInterface {
  name = 'AddStudioPlaylistFolders1837100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "studio_playlist_folders" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "name" character varying(80) NOT NULL,
        "position" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_playlist_folders" PRIMARY KEY ("id"),
        CONSTRAINT "FK_studio_playlist_folders_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_playlist_folders_user_position" ON "studio_playlist_folders" ("user_id", "position", "id")`,
    );
    await queryRunner.query(`
      CREATE TABLE "studio_playlist_folder_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "folder_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "playlist_id" uuid NOT NULL,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_playlist_folder_items" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_studio_playlist_folder_items_user_playlist" UNIQUE ("user_id", "playlist_id"),
        CONSTRAINT "FK_studio_playlist_folder_items_folder" FOREIGN KEY ("folder_id") REFERENCES "studio_playlist_folders"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_studio_playlist_folder_items_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_studio_playlist_folder_items_playlist" FOREIGN KEY ("playlist_id") REFERENCES "studio_playlists"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_playlist_folder_items_folder_id" ON "studio_playlist_folder_items" ("folder_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_playlist_folder_items_playlist_id" ON "studio_playlist_folder_items" ("playlist_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "studio_playlist_folder_items"`);
    await queryRunner.query(`DROP TABLE "studio_playlist_folders"`);
  }
}
