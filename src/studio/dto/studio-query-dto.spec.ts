import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListStudioReleasesQuery } from './list-studio-releases.query';
import { SearchStudioQuery } from './search-studio.query';

const propertiesWithErrors = async (instance: object): Promise<string[]> =>
  (await validate(instance)).map((error) => error.property).sort();

describe('Studio query bodies', () => {
  it('takes a genre from the contract list on the home feed and refuses any other', async () => {
    expect(
      await propertiesWithErrors(
        plainToInstance(ListStudioReleasesQuery, { genre: 'fado' }),
      ),
    ).toEqual([]);
    expect(
      await propertiesWithErrors(
        plainToInstance(ListStudioReleasesQuery, { genre: 'polka' }),
      ),
    ).toEqual(['genre']);
  });

  it('takes a mood from the contract list on the home feed, beside a genre', async () => {
    expect(
      await propertiesWithErrors(
        plainToInstance(ListStudioReleasesQuery, {
          genre: 'electronic',
          mood: 'late-night',
        }),
      ),
    ).toEqual([]);
    expect(
      await propertiesWithErrors(
        plainToInstance(ListStudioReleasesQuery, { mood: 'Late-Night' }),
      ),
    ).toEqual(['mood']);
  });

  it('searches playlists and narrows by genre', async () => {
    expect(
      await propertiesWithErrors(
        plainToInstance(SearchStudioQuery, {
          q: 'night',
          type: 'playlists',
          genre: 'r-and-b',
        }),
      ),
    ).toEqual([]);
    expect(
      await propertiesWithErrors(
        plainToInstance(SearchStudioQuery, { q: 'night', genre: 'Fado' }),
      ),
    ).toEqual(['genre']);
  });

  it('narrows a search by mood and refuses a mood outside the list', async () => {
    expect(
      await propertiesWithErrors(
        plainToInstance(SearchStudioQuery, { q: 'night', mood: 'dreamy' }),
      ),
    ).toEqual([]);
    expect(
      await propertiesWithErrors(
        plainToInstance(SearchStudioQuery, { q: 'night', mood: 'sleepy' }),
      ),
    ).toEqual(['mood']);
  });

  // Studio artist kinds.
  it('takes a format from the contract list on the home feed and in search, and refuses any other', async () => {
    expect(
      await propertiesWithErrors(
        plainToInstance(ListStudioReleasesQuery, { format: 'podcast' }),
      ),
    ).toEqual([]);
    expect(
      await propertiesWithErrors(
        plainToInstance(SearchStudioQuery, {
          q: 'lisbon',
          format: 'spoken_word',
        }),
      ),
    ).toEqual([]);
    expect(
      await propertiesWithErrors(
        plainToInstance(ListStudioReleasesQuery, { format: 'spoken-word' }),
      ),
    ).toEqual(['format']);
    expect(
      await propertiesWithErrors(
        plainToInstance(SearchStudioQuery, { q: 'lisbon', format: 'Podcast' }),
      ),
    ).toEqual(['format']);
  });
});
