import { DataSource } from 'typeorm';
import { NEW_DOMAIN_EXPORT_CONTRIBUTORS } from './data-export-contributors';
import { StudioPlaylistsExportContributor } from './data-export-contributors-studio';
import { EXPORT_CSV_CATEGORIES } from './export-archive';

const USER_ID = '71000000-0000-4000-8000-000000000001';
const PLAYLIST_ID = '72000000-0000-4000-8000-000000000001';
const SECOND_PLAYLIST_ID = '72000000-0000-4000-8000-000000000002';

describe('StudioPlaylistsExportContributor', () => {
  let query: jest.Mock;
  let contributor: StudioPlaylistsExportContributor;

  beforeEach(() => {
    query = jest.fn();
    contributor = new StudioPlaylistsExportContributor({
      query,
    } as unknown as DataSource);
  });

  it('rides on the saved category under its own archive key', () => {
    expect(contributor.category).toBe('saved');
    expect(contributor.archiveKey).toBe('studioPlaylists');
  });

  it('is registered and has a csv file after the persona content', () => {
    expect(NEW_DOMAIN_EXPORT_CONTRIBUTORS).toContain(
      StudioPlaylistsExportContributor,
    );
    const csvKeys: readonly string[] = EXPORT_CSV_CATEGORIES;
    expect(csvKeys.indexOf('studioPlaylists')).toBe(
      csvKeys.indexOf('personaContent') + 1,
    );
  });

  it('answers an empty list without reading entries when the member has no playlists', async () => {
    query.mockResolvedValueOnce([]);
    await expect(contributor.buildContribution(USER_ID)).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([USER_ID]);
  });

  it('writes each playlist with its credit name and its tracks in order', async () => {
    query
      .mockResolvedValueOnce([
        {
          id: PLAYLIST_ID,
          name: 'Night bus',
          description: 'For the N1',
          visibility: 'public',
          credit_name: 'Night Shift',
          created_at: new Date('2026-10-10T09:00:00.000Z'),
          updated_at: new Date('2026-10-11T09:00:00.000Z'),
        },
        {
          id: SECOND_PLAYLIST_ID,
          name: 'Just mine',
          description: null,
          visibility: 'private',
          credit_name: null,
          created_at: new Date('2026-10-12T09:00:00.000Z'),
          updated_at: new Date('2026-10-12T09:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([
        {
          playlist_id: PLAYLIST_ID,
          track_title: 'Opening',
          artist_name: 'Lia',
          added_at: new Date('2026-10-10T09:05:00.000Z'),
        },
        {
          playlist_id: PLAYLIST_ID,
          track_title: null,
          artist_name: null,
          added_at: new Date('2026-10-10T09:06:00.000Z'),
        },
      ]);

    const archive = await contributor.buildContribution(USER_ID);

    expect(query.mock.calls[1]?.[1]).toEqual([
      [PLAYLIST_ID, SECOND_PLAYLIST_ID],
    ]);
    expect(archive).toEqual([
      {
        id: PLAYLIST_ID,
        name: 'Night bus',
        description: 'For the N1',
        visibility: 'public',
        creditName: 'Night Shift',
        tracks: [
          {
            title: 'Opening',
            artist: 'Lia',
            addedAt: '2026-10-10T09:05:00.000Z',
          },
          {
            title: null,
            artist: null,
            addedAt: '2026-10-10T09:06:00.000Z',
          },
        ],
        createdAt: '2026-10-10T09:00:00.000Z',
        updatedAt: '2026-10-11T09:00:00.000Z',
      },
      {
        id: SECOND_PLAYLIST_ID,
        name: 'Just mine',
        description: null,
        visibility: 'private',
        creditName: null,
        tracks: [],
        createdAt: '2026-10-12T09:00:00.000Z',
        updatedAt: '2026-10-12T09:00:00.000Z',
      },
    ]);
  });

  it('reads only the playlists the member owns', async () => {
    query.mockResolvedValueOnce([]);
    await contributor.buildContribution(USER_ID);
    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain(`WHERE "playlist"."user_id" = $1`);
    expect(sql).not.toContain('"credit_persona"."user_id"');
  });
});
