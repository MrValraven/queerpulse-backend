import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AdminStudioSearchQuery,
  AdminStudioShelfParams,
  CreateAdminStudioPickDto,
  ReorderAdminStudioPicksDto,
  UpdateAdminStudioPickDto,
} from './admin-studio-curation.dto';

const RELEASE_ID = 'd7000000-0000-4000-8000-000000000001';

const errorsFor = async <BodyClass extends object>(
  dtoClass: ClassConstructor<BodyClass>,
  body: object,
): Promise<string[]> =>
  (await validate(plainToInstance(dtoClass, body)))
    .map((error) => error.property)
    .sort();

describe('Admin curation bodies', () => {
  it('takes a shelf from the vocabulary, a release id and an optional note', async () => {
    expect(
      await errorsFor(CreateAdminStudioPickDto, {
        shelf: 'staff_picks',
        releaseId: RELEASE_ID,
      }),
    ).toEqual([]);
    expect(
      await errorsFor(CreateAdminStudioPickDto, {
        shelf: 'hero',
        releaseId: 'not-a-uuid',
        note: 'x'.repeat(141),
      }),
    ).toEqual(['note', 'releaseId', 'shelf']);
  });

  it('trims a note and takes null to clear it', async () => {
    const trimmed = plainToInstance(UpdateAdminStudioPickDto, {
      note: '  Out tonight  ',
    });
    expect(trimmed.note).toBe('Out tonight');
    expect(await errorsFor(UpdateAdminStudioPickDto, { note: null })).toEqual(
      [],
    );
    expect(await errorsFor(UpdateAdminStudioPickDto, {})).toEqual(['note']);
  });

  it('takes up to 12 pick ids for a reorder', async () => {
    expect(
      await errorsFor(ReorderAdminStudioPicksDto, { pickIds: [RELEASE_ID] }),
    ).toEqual([]);
    expect(
      await errorsFor(ReorderAdminStudioPicksDto, {
        pickIds: Array.from({ length: 13 }, () => RELEASE_ID),
      }),
    ).toEqual(['pickIds']);
  });

  it('refuses a shelf path outside the vocabulary', async () => {
    expect(
      await errorsFor(AdminStudioShelfParams, { shelf: 'new_this_week' }),
    ).toEqual([]);
    expect(await errorsFor(AdminStudioShelfParams, { shelf: 'hero' })).toEqual([
      'shelf',
    ]);
  });

  it('takes a search term of 1 to 80 characters after trimming', async () => {
    expect(await errorsFor(AdminStudioSearchQuery, { q: ' lisbon ' })).toEqual(
      [],
    );
    expect(await errorsFor(AdminStudioSearchQuery, { q: '   ' })).toEqual([
      'q',
    ]);
    expect(
      await errorsFor(AdminStudioSearchQuery, { q: 'x'.repeat(81) }),
    ).toEqual(['q']);
  });
});
