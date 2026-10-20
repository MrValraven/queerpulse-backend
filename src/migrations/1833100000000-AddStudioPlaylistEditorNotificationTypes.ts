// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Collaborative playlists
 * (`QUEERPULSE-STUDIO-COLLAB-PLAYLISTS-DESIGN-2026-10-14.md`, section 5):
 * four labels join `notifications_type_enum`: an invitation to edit a
 * playlist, its acceptance, its decline, and a pick as editor of a persona's
 * playlist.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration
 * here: a new label must be COMMITTED before any statement may use it, so
 * this opts out of the wrapping transaction (`transaction = false`, honoured
 * because `data-source.ts` sets `migrationsTransactionMode: 'each'`). Nothing
 * in this file uses the labels, and `IF NOT EXISTS` keeps a re-run safe.
 */
export class AddStudioPlaylistEditorNotificationTypes1833100000000 implements MigrationInterface {
  name = 'AddStudioPlaylistEditorNotificationTypes1833100000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_playlist_editor_invite'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_playlist_editor_invite_accepted'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_playlist_editor_invite_declined'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_playlist_editor_added'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop an enum value, and the added labels are inert
    // once nothing writes them. Fails loudly so the ledger row stays.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
