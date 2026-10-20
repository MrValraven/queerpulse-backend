import { getMetadataArgsStorage } from 'typeorm';
import { StudioPlaylistTrack } from './studio-playlist-track.entity';
import {
  LIVE_STUDIO_PLAYLIST_EDITOR_STATUSES,
  StudioPlaylistEditor,
  StudioPlaylistEditorSource,
  StudioPlaylistEditorStatus,
} from './studio-playlist-editor.entity';

const metadata = getMetadataArgsStorage();

const columnOptions = (
  target: object,
  propertyName: string,
): Record<string, unknown> =>
  (metadata.columns.find(
    (column) =>
      column.target === target && column.propertyName === propertyName,
  )?.options ?? {}) as Record<string, unknown>;

describe('StudioPlaylistEditor entity', () => {
  it('maps to the table, the unique pair, the status index and the source check the migration creates', () => {
    expect(
      metadata.tables.find((table) => table.target === StudioPlaylistEditor)
        ?.name,
    ).toBe('studio_playlist_editors');
    expect(
      metadata.uniques.find((unique) => unique.target === StudioPlaylistEditor),
    ).toEqual(
      expect.objectContaining({
        name: 'UQ_studio_playlist_editors_playlist_user',
        columns: ['playlistId', 'userId'],
      }),
    );
    expect(
      metadata.indices.find((index) => index.target === StudioPlaylistEditor),
    ).toEqual(
      expect.objectContaining({
        name: 'IDX_studio_playlist_editors_user_status',
        columns: ['userId', 'status'],
      }),
    );
    expect(
      metadata.checks.find((check) => check.target === StudioPlaylistEditor),
    ).toEqual(
      expect.objectContaining({
        name: 'CHK_studio_playlist_editors_persona_source',
        expression: `"source" <> 'persona_co_owner' OR "status" NOT IN ('invited', 'declined')`,
      }),
    );
  });

  it('stores both enums under the names the migration creates', () => {
    expect(columnOptions(StudioPlaylistEditor, 'source')).toEqual(
      expect.objectContaining({
        enumName: 'studio_playlist_editors_source_enum',
      }),
    );
    expect(columnOptions(StudioPlaylistEditor, 'status')).toEqual(
      expect.objectContaining({
        enumName: 'studio_playlist_editors_status_enum',
        default: StudioPlaylistEditorStatus.Invited,
      }),
    );
    expect(Object.values(StudioPlaylistEditorSource)).toEqual([
      'member_invite',
      'persona_co_owner',
    ]);
    expect(Object.values(StudioPlaylistEditorStatus)).toEqual([
      'invited',
      'active',
      'declined',
      'revoked',
      'left',
    ]);
  });

  it('keeps the three timestamps at millisecond precision', () => {
    for (const propertyName of ['invitedAt', 'acceptedAt', 'endedAt']) {
      expect(columnOptions(StudioPlaylistEditor, propertyName)).toEqual(
        expect.objectContaining({ type: 'timestamptz', precision: 3 }),
      );
    }
  });

  it('counts invited and active as the live statuses', () => {
    expect(LIVE_STUDIO_PLAYLIST_EDITOR_STATUSES).toEqual([
      StudioPlaylistEditorStatus.Invited,
      StudioPlaylistEditorStatus.Active,
    ]);
  });

  it('gives a playlist entry a nullable added by column named by the naming strategy', () => {
    const options = columnOptions(StudioPlaylistTrack, 'addedByUserId');
    expect(options).toEqual(
      expect.objectContaining({ type: 'uuid', nullable: true }),
    );
    expect(options).not.toHaveProperty('name');
  });
});
