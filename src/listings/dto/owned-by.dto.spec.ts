import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { AdminCreateListingDto } from './admin-create-listing.dto';
import { AdminUpdateListingDto } from './admin-update-listing.dto';
import { CreateListingDto } from './create-listing.dto';
import { ListListingDirectoryQuery } from './list-directory.query';
import { UpdateListingDto } from './update-listing.dto';

/**
 * `ownedBy` on the listing write bodies, and the directory's `owned=` filter.
 *
 * The write bodies carry many required fields that play no part here, so each
 * case looks only at the errors reported for `ownedBy` itself, validated with
 * the production pipe's `whitelist` + `forbidNonWhitelisted` so a body that
 * does not declare the field reports it as non-whitelisted.
 */

type BodyDto =
  | typeof CreateListingDto
  | typeof UpdateListingDto
  | typeof AdminCreateListingDto
  | typeof AdminUpdateListingDto;

async function ownedByErrors(dtoClass: BodyDto, ownedBy: unknown) {
  const instance = plainToInstance(dtoClass, { ownedBy });
  const errors = await validate(instance as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.filter((error) => error.property === 'ownedBy');
}

describe.each([
  ['CreateListingDto', CreateListingDto],
  ['UpdateListingDto', UpdateListingDto],
] as [string, BodyDto][])('%s ownedBy', (_name, dtoClass) => {
  it.each([
    [[]],
    [['women']],
    [['trans']],
    [['nonbinary']],
    [['women', 'trans', 'nonbinary']],
  ])('accepts %j', async (value) => {
    expect(await ownedByErrors(dtoClass, value)).toHaveLength(0);
  });

  it('accepts a body that leaves it out', async () => {
    expect(await ownedByErrors(dtoClass, undefined)).toHaveLength(0);
  });

  it.each([[['queer']], [['women', 'Women']], [['']], [[true]]])(
    'rejects the unknown value in %j',
    async (value) => {
      const errors = await ownedByErrors(dtoClass, value);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.constraints).toHaveProperty('isIn');
    },
  );

  it('rejects a duplicate value', async () => {
    const errors = await ownedByErrors(dtoClass, ['women', 'women']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.constraints).toHaveProperty('arrayUnique');
  });

  it.each(['women', 'women,trans', true])(
    'rejects the non-array %p',
    async (value) => {
      const errors = await ownedByErrors(dtoClass, value);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.constraints).toHaveProperty('isArray');
    },
  );
});

// Who owns the business is the owner's own disclosure, so neither staff body
// declares it and the global pipe refuses a body that sends it.
describe.each([
  ['AdminCreateListingDto', AdminCreateListingDto],
  ['AdminUpdateListingDto', AdminUpdateListingDto],
] as [string, BodyDto][])('%s ownedBy', (_name, dtoClass) => {
  it('refuses it as a non-whitelisted property', async () => {
    const errors = await ownedByErrors(dtoClass, ['women']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.constraints).toHaveProperty('whitelistValidation');
  });
});

describe('ListListingDirectoryQuery owned', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
  const run = (query: Record<string, unknown>) =>
    pipe.transform(query, {
      type: 'query',
      metatype: ListListingDirectoryQuery,
    }) as Promise<ListListingDirectoryQuery>;

  it('accepts a single value as a one-item list', async () => {
    const query = await run({ owned: 'women' });
    expect(query.owned).toEqual(['women']);
  });

  it('accepts a comma-joined list', async () => {
    const query = await run({ owned: 'trans,women' });
    expect(query.owned).toEqual(['women', 'trans']);
  });

  it('accepts a repeated parameter, meaning the same as the comma-joined one', async () => {
    const query = await run({ owned: ['trans', 'women'] });
    expect(query.owned).toEqual(['women', 'trans']);
  });

  it('de-duplicates and sorts into canonical order', async () => {
    const query = await run({
      owned: ['nonbinary,women', 'women', ' trans '],
    });
    expect(query.owned).toEqual(['women', 'trans', 'nonbinary']);
  });

  it('leaves `owned` unset when it is absent', async () => {
    const query = await run({});
    expect(query.owned).toBeUndefined();
  });

  it('keeps `owned` alongside the paged-grid params', async () => {
    await expect(
      run({ owned: 'women', page: '2', cat: 'food' }),
    ).resolves.toMatchObject({ owned: ['women'], page: 2, cat: 'food' });
  });

  it.each([
    'queer',
    'WOMEN',
    'women,queer',
    'women,non-binary',
    ['women', 'queer'],
  ])('rejects `owned=%p` with a 400', async (owned) => {
    await expect(run({ owned })).rejects.toBeInstanceOf(BadRequestException);
  });
});
