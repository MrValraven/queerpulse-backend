import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListAdminStudioDisputesQuery } from './list-admin-studio-disputes.query';
import { ListAdminStudioReleasesQuery } from './list-admin-studio-releases.query';

const failingFields = async (
  queryClass: new () => object,
  query: Record<string, unknown>,
): Promise<string[]> =>
  (await validate(plainToInstance(queryClass, query)))
    .map((error) => error.property)
    .sort();

describe('Studio flag-review queries', () => {
  it('lists disputes by any of the three statuses, or none', async () => {
    for (const status of ['open', 'upheld', 'rejected']) {
      expect(
        await failingFields(ListAdminStudioDisputesQuery, { status }),
      ).toEqual([]);
    }
    expect(await failingFields(ListAdminStudioDisputesQuery, {})).toEqual([]);
    expect(
      await failingFields(ListAdminStudioDisputesQuery, { status: 'closed' }),
    ).toEqual(['status']);
  });

  it('bounds the cursor like the other Studio lists', async () => {
    expect(
      await failingFields(ListAdminStudioDisputesQuery, {
        cursor: 'x'.repeat(201),
      }),
    ).toEqual(['cursor']);
  });

  it('lists releases for the taken_down status only, and needs it', async () => {
    expect(
      await failingFields(ListAdminStudioReleasesQuery, {
        status: 'taken_down',
      }),
    ).toEqual([]);
    expect(await failingFields(ListAdminStudioReleasesQuery, {})).toEqual([
      'status',
    ]);
    expect(
      await failingFields(ListAdminStudioReleasesQuery, {
        status: 'published',
      }),
    ).toEqual(['status']);
  });
});
