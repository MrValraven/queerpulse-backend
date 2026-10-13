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
 * The listing attribute fields on all four write bodies, and the new
 * directory filters. The write bodies carry many required fields that play
 * no part here, so each case looks only at the errors reported for the one
 * property under test, validated with the production pipe's `whitelist` +
 * `forbidNonWhitelisted`.
 */

type BodyDto =
  | typeof CreateListingDto
  | typeof UpdateListingDto
  | typeof AdminCreateListingDto
  | typeof AdminUpdateListingDto;

async function errorsFor(dtoClass: BodyDto, property: string, value: unknown) {
  const instance = plainToInstance(dtoClass, { [property]: value });
  const errors = await validate(instance as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.filter((error) => error.property === property);
}

describe.each([
  ['CreateListingDto', CreateListingDto],
  ['UpdateListingDto', UpdateListingDto],
  ['AdminCreateListingDto', AdminCreateListingDto],
  ['AdminUpdateListingDto', AdminUpdateListingDto],
] as [string, BodyDto][])('%s listing attributes', (_name, dtoClass) => {
  it.each([
    ['attributes', ['terrace', 'dj-nights']],
    ['attributes', []],
    ['highlights', ['terrace']],
    ['entryMode', 'membersOnly'],
    ['entryMode', null],
    ['coverPolicy', 'freeBefore'],
    ['coverPolicy', null],
    ['coverFreeBefore', '23:30'],
    ['coverFreeBefore', '00:00'],
    ['coverFreeBefore', null],
    ['payments', ['card', 'mbway', 'multibanco', 'cash']],
    ['issuesNifInvoices', false],
    ['issuesNifInvoices', null],
    ['inclusionPractices', ['chosen-name', 'safer-space-policy']],
    ['saferSpacePolicyUrl', 'example.org/safer-space'],
    ['saferSpacePolicyUrl', 'https://example.org/safer-space'],
    ['saferSpacePolicyUrl', ''],
    ['saferSpacePolicyUrl', null],
    ['langs', ['pt', 'pt-BR', 'kea', 'ils']],
    // Legacy names from an old cached frontend map to codes, for one release.
    ['langs', ['Português']],
    ['langs', ['English', 'Other']],
    // A repeated value is deduped before the validators see it.
    ['langs', ['pt', 'pt']],
    ['langsOther', 'Tetum'],
    // Retired, still accepted for one release and ignored by the service.
    ['tags', ['Terrace']],
    ['goodFor', ['Solo-friendly']],
  ] as [string, unknown][])('accepts %s = %j', async (property, value) => {
    expect(await errorsFor(dtoClass, property, value)).toHaveLength(0);
  });

  it.each([
    [
      'attributes',
      Array.from({ length: 41 }, (_entry, index) => `slug-${index}`),
    ],
    ['attributes', ['terrace', 'terrace']],
    ['attributes', ['x'.repeat(41)]],
    ['attributes', 'terrace'],
    ['highlights', ['live-music', 'dj-nights', 'terrace', 'karaoke']],
    ['entryMode', 'walkInsWelcome'],
    ['coverPolicy', 'donation'],
    ['coverFreeBefore', '24:00'],
    ['coverFreeBefore', '9:00'],
    ['payments', ['paypal']],
    ['payments', ['card', 'card']],
    ['issuesNifInvoices', 'yes'],
    ['inclusionPractices', ['gender-neutral-pricing']],
    ['saferSpacePolicyUrl', 'javascript:alert(1)'],
    ['saferSpacePolicyUrl', 'localhost'],
    ['saferSpacePolicyUrl', 'x'.repeat(301)],
    ['langs', ['pt-br']],
    ['langs', ['Português', 'Klingon']],
    ['langs', 'English'],
    ['langsOther', 'x'.repeat(81)],
  ] as [string, unknown][])('rejects %s = %j', async (property, value) => {
    expect(await errorsFor(dtoClass, property, value)).not.toHaveLength(0);
  });

  it('maps a legacy language name to its code', async () => {
    const instance = plainToInstance(dtoClass, { langs: ['Português'] });

    expect(instance.langs).toEqual(['pt']);
    expect(await errorsFor(dtoClass, 'langs', ['Português'])).toHaveLength(0);
  });

  it('drops "Other" from the languages', async () => {
    const instance = plainToInstance(dtoClass, {
      langs: ['Other', 'English'],
    });

    expect(instance.langs).toEqual(['en']);
    expect(plainToInstance(dtoClass, { langs: ['Other'] }).langs).toEqual([]);
  });

  it('maps names mixed with codes, deduping in first-seen order', async () => {
    const mixed = [' english ', 'pt-BR', 'Français', 'en', 'LGP (sign)', 'kea'];
    const instance = plainToInstance(dtoClass, { langs: mixed });

    expect(instance.langs).toEqual(['en', 'pt-BR', 'fr', 'lgp', 'kea']);
    expect(await errorsFor(dtoClass, 'langs', mixed)).toHaveLength(0);
  });

  it('trims langsOther before it checks the length', async () => {
    const paddedText = `  ${'x'.repeat(80)}  `;
    const instance = plainToInstance(dtoClass, { langsOther: paddedText });

    expect(instance.langsOther).toBe('x'.repeat(80));
    expect(await errorsFor(dtoClass, 'langsOther', paddedText)).toHaveLength(0);
  });
});

describe('ListListingDirectoryQuery attribute filters', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
  const run = (query: Record<string, unknown>) =>
    pipe.transform(query, {
      type: 'query',
      metatype: ListListingDirectoryQuery,
    }) as Promise<ListListingDirectoryQuery>;

  it('reads attr repeated or comma-joined as the same list, each slug once', async () => {
    await expect(run({ attr: 'terrace, wifi' })).resolves.toMatchObject({
      attr: ['terrace', 'wifi'],
    });
    await expect(
      run({ attr: ['terrace', 'wifi', 'terrace'] }),
    ).resolves.toMatchObject({ attr: ['terrace', 'wifi'] });
  });

  it.each([
    'rooftop-pool',
    'sexual-health-prep',
    'terrace,trans-care-experience',
  ])('answers 400 to attr=%p, an unknown or sensitive slug', async (attr) => {
    await expect(run({ attr })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts one entry value', async () => {
    await expect(run({ entry: 'walkIn' })).resolves.toMatchObject({
      entry: 'walkIn',
    });
  });

  it.each(['walkin', ['walkIn', 'membersOnly']])(
    'answers 400 to entry=%p',
    async (entry) => {
      await expect(run({ entry })).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('reads pay, lang and practice the way it reads access', async () => {
    await expect(
      run({
        pay: 'mbway,cash',
        lang: ['pt', 'pt-BR'],
        practice: 'chosen-name',
      }),
    ).resolves.toMatchObject({
      pay: ['mbway', 'cash'],
      lang: ['pt', 'pt-BR'],
      practice: ['chosen-name'],
    });
  });

  it.each([
    { pay: 'paypal' },
    { lang: 'Português' },
    { lang: 'pt-br' },
    { practice: 'harm-reductions' },
  ])('answers 400 to %j', async (query) => {
    await expect(run(query)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps the new filters alongside the paged-grid params', async () => {
    await expect(
      run({ attr: 'terrace', owned: 'migrant', page: '2' }),
    ).resolves.toMatchObject({
      attr: ['terrace'],
      owned: ['migrant'],
      page: 2,
    });
  });

  it('leaves every new filter unset when the query carries none', async () => {
    const query = await run({});
    expect(query.attr).toBeUndefined();
    expect(query.entry).toBeUndefined();
    expect(query.pay).toBeUndefined();
    expect(query.lang).toBeUndefined();
    expect(query.practice).toBeUndefined();
  });
});
