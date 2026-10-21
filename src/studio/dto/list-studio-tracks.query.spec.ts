import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ListStudioTracksQuery,
  MAX_STUDIO_TRACK_BATCH_IDS,
} from './list-studio-tracks.query';

const uuidAt = (index: number) =>
  `c7000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

const toQuery = (ids: unknown) =>
  plainToInstance(ListStudioTracksQuery, { ids });

const propertiesWithErrors = async (instance: object): Promise<string[]> =>
  (await validate(instance)).map((error) => error.property).sort();

describe('ListStudioTracksQuery', () => {
  it('splits the comma list and trims each id', async () => {
    const query = toQuery(` ${uuidAt(1)} ,${uuidAt(2)},`);
    expect(query.ids).toEqual([uuidAt(1), uuidAt(2)]);
    expect(await propertiesWithErrors(query)).toEqual([]);
  });

  it(`takes up to ${MAX_STUDIO_TRACK_BATCH_IDS} ids and refuses one more`, async () => {
    const idsUpTo = (count: number) =>
      Array.from({ length: count }, (_unused, index) => uuidAt(index + 1)).join(
        ',',
      );
    expect(
      await propertiesWithErrors(toQuery(idsUpTo(MAX_STUDIO_TRACK_BATCH_IDS))),
    ).toEqual([]);
    expect(
      await propertiesWithErrors(
        toQuery(idsUpTo(MAX_STUDIO_TRACK_BATCH_IDS + 1)),
      ),
    ).toEqual(['ids']);
  });

  it('refuses an id that is not a uuid', async () => {
    expect(
      await propertiesWithErrors(toQuery(`${uuidAt(1)},not-a-uuid`)),
    ).toEqual(['ids']);
  });

  it('refuses the same id twice', async () => {
    expect(
      await propertiesWithErrors(toQuery(`${uuidAt(1)},${uuidAt(1)}`)),
    ).toEqual(['ids']);
  });

  it('refuses an empty or missing list', async () => {
    expect(await propertiesWithErrors(toQuery(''))).toEqual(['ids']);
    expect(await propertiesWithErrors(toQuery(','))).toEqual(['ids']);
    expect(await propertiesWithErrors(toQuery(undefined))).toEqual(['ids']);
  });
});
