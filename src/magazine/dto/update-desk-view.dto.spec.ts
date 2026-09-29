import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateDeskViewDto } from './update-desk-view.dto';

/**
 * A PATCH leaves every omitted field alone, and a present field has to hold
 * a real value: a null name would reach a NOT NULL column as a 500, and a
 * null position would quietly move the view to the top of the list.
 */
describe('UpdateDeskViewDto', () => {
  const propertiesWithErrors = async (
    payload: Record<string, unknown>,
  ): Promise<string[]> => {
    const errors = await validate(plainToInstance(UpdateDeskViewDto, payload));
    return errors.map((error) => error.property);
  };

  it('accepts an empty body', async () => {
    expect(await propertiesWithErrors({})).toEqual([]);
  });

  it('accepts a rename, a move and a new query', async () => {
    expect(
      await propertiesWithErrors({
        name: '  This issue ',
        position: 2,
        query: { track: 'issue' },
      }),
    ).toEqual([]);
  });

  it('refuses a null name', async () => {
    expect(await propertiesWithErrors({ name: null })).toEqual(['name']);
  });

  it('refuses a null position', async () => {
    expect(await propertiesWithErrors({ position: null })).toEqual([
      'position',
    ]);
  });

  it('refuses a null query', async () => {
    expect(await propertiesWithErrors({ query: null })).toEqual(['query']);
  });
});
