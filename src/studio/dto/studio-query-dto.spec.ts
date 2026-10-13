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
});
