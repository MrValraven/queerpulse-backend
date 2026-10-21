import { DataSource } from 'typeorm';
import { NEW_DOMAIN_EXPORT_CONTRIBUTORS } from './data-export-contributors';
import { StudioPlaylistFoldersExportContributor } from './data-export-contributors-studio';

const USER_ID = '71000000-0000-4000-8000-000000000001';
const FOLDER_ID = '73000000-0000-4000-8000-000000000001';
const PLAYLIST_ID = '72000000-0000-4000-8000-000000000001';

describe('StudioPlaylistFoldersExportContributor', () => {
  let query: jest.Mock;
  let contributor: StudioPlaylistFoldersExportContributor;

  beforeEach(() => {
    query = jest.fn();
    contributor = new StudioPlaylistFoldersExportContributor({
      query,
    } as unknown as DataSource);
  });

  it('rides on the saved category under its own archive key and is registered', () => {
    expect(contributor.category).toBe('saved');
    expect(contributor.archiveKey).toBe('studioPlaylistFolders');
    expect(NEW_DOMAIN_EXPORT_CONTRIBUTORS).toContain(
      StudioPlaylistFoldersExportContributor,
    );
  });

  it('answers an empty list without reading filings when the member has no folders', async () => {
    query.mockResolvedValueOnce([]);
    await expect(contributor.buildContribution(USER_ID)).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('exports each folder with the playlists filed in it, by id only', async () => {
    query
      .mockResolvedValueOnce([
        {
          id: FOLDER_ID,
          name: 'Late nights',
          position: 0,
          created_at: new Date('2026-10-01T22:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([
        {
          folder_id: FOLDER_ID,
          playlist_id: PLAYLIST_ID,
          filed_at: new Date('2026-10-02T09:00:00.000Z'),
        },
      ]);
    await expect(contributor.buildContribution(USER_ID)).resolves.toEqual([
      {
        name: 'Late nights',
        position: 0,
        createdAt: '2026-10-01T22:00:00.000Z',
        playlists: [
          { playlistId: PLAYLIST_ID, filedAt: '2026-10-02T09:00:00.000Z' },
        ],
      },
    ]);
    for (const [, parameters] of query.mock.calls as [string, unknown[]][])
      expect(parameters).toEqual([USER_ID]);
  });
});
