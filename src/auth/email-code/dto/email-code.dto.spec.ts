import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RequestEmailCodeDto } from './email-code.dto';

describe('RequestEmailCodeDto', () => {
  const propertiesWithErrors = async (
    payload: Record<string, unknown>,
  ): Promise<string[]> => {
    const errors = await validate(
      plainToInstance(RequestEmailCodeDto, payload),
    );
    return errors.map((error) => error.property);
  };

  it('accepts a body without isRegistration', async () => {
    expect(
      await propertiesWithErrors({ email: 'sam@example.com', locale: 'en' }),
    ).toEqual([]);
  });

  it.each([true, false])(
    'accepts isRegistration %s',
    async (isRegistration) => {
      expect(
        await propertiesWithErrors({
          email: 'sam@example.com',
          isRegistration,
        }),
      ).toEqual([]);
    },
  );

  it.each(['true', 1])(
    'rejects isRegistration %p because it is not a boolean',
    async (isRegistration) => {
      expect(
        await propertiesWithErrors({
          email: 'sam@example.com',
          isRegistration,
        }),
      ).toEqual(['isRegistration']);
    },
  );
});
