import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioListeningController } from './studio-listening.controller';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';

const VIEWER = { userId: 'viewer-1' } as CurrentUserData;
const PERSONA_ID = 'b1000000-0000-4000-8000-000000000001';
const playlistCard = { id: 'playlist-1' };

describe('StudioListeningController', () => {
  let catalog: {
    listReleases: jest.Mock;
    listGenres: jest.Mock;
    listMoods: jest.Mock;
    listFormats: jest.Mock;
    search: jest.Mock;
    getArtist: jest.Mock;
  };
  let playlistReads: {
    searchPlaylists: jest.Mock;
    listForArtistView: jest.Mock;
  };
  let controller: StudioListeningController;

  beforeEach(() => {
    catalog = {
      listReleases: jest.fn().mockResolvedValue({ items: [] }),
      listGenres: jest.fn().mockResolvedValue({ genres: ['fado'], covers: {} }),
      listMoods: jest.fn().mockResolvedValue({ moods: ['tender'], covers: {} }),
      listFormats: jest
        .fn()
        .mockResolvedValue({ formats: ['music', 'podcast'] }),
      search: jest
        .fn()
        .mockResolvedValue({ releases: [], tracks: [], artists: [] }),
      getArtist: jest.fn().mockResolvedValue({ artist: { id: PERSONA_ID } }),
    };
    playlistReads = {
      searchPlaylists: jest.fn().mockResolvedValue([playlistCard]),
      listForArtistView: jest.fn().mockResolvedValue([playlistCard]),
    };
    controller = new StudioListeningController(
      catalog as unknown as StudioCatalogService,
      playlistReads as unknown as StudioPlaylistReadsService,
    );
  });

  it('passes the genre and the mood to the home feed', async () => {
    await controller.listReleases(VIEWER, {
      cursor: 'abc',
      genre: 'fado',
      mood: 'tender',
    });
    expect(catalog.listReleases).toHaveBeenCalledWith('viewer-1', 'abc', {
      genre: 'fado',
      mood: 'tender',
    });
  });

  it('serves the moods the viewer can hear', async () => {
    await expect(controller.listMoods(VIEWER)).resolves.toEqual({
      moods: ['tender'],
      covers: {},
    });
    expect(catalog.listMoods).toHaveBeenCalledWith('viewer-1');
  });

  it('serves the genres the viewer can hear', async () => {
    await expect(controller.listGenres(VIEWER)).resolves.toEqual({
      genres: ['fado'],
      covers: {},
    });
  });

  it.each(['all', 'playlists'] as const)(
    'adds public playlists to a %s search',
    async (type) => {
      const result = await controller.search(VIEWER, {
        q: 'night',
        type,
        genre: 'fado',
      });
      expect(catalog.search).toHaveBeenCalledWith('viewer-1', 'night', type, {
        genre: 'fado',
        mood: undefined,
      });
      expect(playlistReads.searchPlaylists).toHaveBeenCalledWith(
        'viewer-1',
        'night',
      );
      expect(result.playlists).toEqual([playlistCard]);
    },
  );

  it('answers an empty playlist list for a release search, without asking for playlists', async () => {
    const result = await controller.search(VIEWER, {
      q: 'night',
      type: 'releases',
    });
    expect(playlistReads.searchPlaylists).not.toHaveBeenCalled();
    expect(result.playlists).toEqual([]);
  });

  it('reads a search with no type as all', async () => {
    await controller.search(VIEWER, { q: 'night' });
    expect(catalog.search).toHaveBeenCalledWith('viewer-1', 'night', 'all', {
      genre: undefined,
      mood: undefined,
    });
  });

  it('adds the persona playlists to the artist page once the artist is visible', async () => {
    const artist = await controller.getArtist(VIEWER, PERSONA_ID);
    expect(artist.playlists).toEqual([playlistCard]);
    expect(playlistReads.listForArtistView).toHaveBeenCalledWith(
      'viewer-1',
      PERSONA_ID,
    );
    const artistOrder = catalog.getArtist.mock.invocationCallOrder[0] ?? 0;
    const playlistsOrder =
      playlistReads.listForArtistView.mock.invocationCallOrder[0] ?? 0;
    expect(artistOrder).toBeLessThan(playlistsOrder);
  });

  // Studio artist kinds.
  it('serves the formats the viewer can hear', async () => {
    await expect(controller.listFormats(VIEWER)).resolves.toEqual({
      formats: ['music', 'podcast'],
    });
    expect(catalog.listFormats).toHaveBeenCalledWith('viewer-1');
  });

  it('passes the format to the home feed and to search', async () => {
    await controller.listReleases(VIEWER, { format: 'podcast' });
    expect(catalog.listReleases).toHaveBeenCalledWith('viewer-1', undefined, {
      genre: undefined,
      mood: undefined,
      format: 'podcast',
    });
    await controller.search(VIEWER, {
      q: 'lisbon',
      type: 'artists',
      format: 'spoken_word',
    });
    expect(catalog.search).toHaveBeenCalledWith(
      'viewer-1',
      'lisbon',
      'artists',
      {
        genre: undefined,
        mood: undefined,
        format: 'spoken_word',
      },
    );
  });
});
