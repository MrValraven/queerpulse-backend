import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ListLikedStatusQuery,
  MAX_STUDIO_LIKED_STATUS_IDS,
} from './list-liked-status.query';

const TRACK_A = 'b1000000-0000-4000-8000-000000000001';
const TRACK_B = 'b1000000-0000-4000-8000-000000000002';

const failedConstraints = async (ids: unknown): Promise<string[]> => {
  const errors = await validate(plainToInstance(ListLikedStatusQuery, { ids }));
  return errors.flatMap((error) => Object.keys(error.constraints ?? {})).sort();
};

const uuidAt = (index: number): string =>
  `b2000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

describe('ListLikedStatusQuery', () => {
  it('splits a comma list into trimmed ids and skips empty parts', () => {
    const query = plainToInstance(ListLikedStatusQuery, {
      ids: ` ${TRACK_A}, ${TRACK_B},,`,
    });
    expect(query.ids).toEqual([TRACK_A, TRACK_B]);
  });

  it('accepts one id and a full list of 100', async () => {
    expect(await failedConstraints(TRACK_A)).toEqual([]);
    const full = Array.from({ length: MAX_STUDIO_LIKED_STATUS_IDS }, (_, i) =>
      uuidAt(i),
    ).join(',');
    expect(await failedConstraints(full)).toEqual([]);
  });

  it('refuses a 101st id with the size reason', async () => {
    const tooMany = Array.from(
      { length: MAX_STUDIO_LIKED_STATUS_IDS + 1 },
      (_, i) => uuidAt(i),
    ).join(',');
    expect(await failedConstraints(tooMany)).toEqual(['arrayMaxSize']);
  });

  it('refuses an id that is not a uuid with the uuid reason', async () => {
    expect(await failedConstraints(`${TRACK_A},not-a-uuid`)).toEqual([
      'isUuid',
    ]);
  });

  it('refuses a missing or empty list', async () => {
    expect(await failedConstraints(undefined)).toContain('isArray');
    expect(await failedConstraints('')).toEqual(['arrayNotEmpty']);
    expect(await failedConstraints(' , ')).toEqual(['arrayNotEmpty']);
  });

  it('refuses the same id named twice', async () => {
    expect(await failedConstraints(`${TRACK_A},${TRACK_A}`)).toEqual([
      'arrayUnique',
    ]);
  });
});
