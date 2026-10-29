import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AdminStudioSpotlightArtistSearchQuery,
  PlaceAdminStudioSpotlightArtistDto,
  ReorderAdminStudioNewStarsDto,
  UpdateAdminStudioSpotlightArtistDto,
} from './admin-studio-spotlight.dto';

const PERSONA_ID = 'd7000000-0000-4000-8000-000000000001';

const errorsFor = async <BodyClass extends object>(
  dtoClass: ClassConstructor<BodyClass>,
  body: object,
): Promise<string[]> =>
  (await validate(plainToInstance(dtoClass, body)))
    .map((error) => error.property)
    .sort();

describe('Admin spotlight bodies', () => {
  it('takes a persona id and an optional note of up to 140 characters', async () => {
    expect(
      await errorsFor(PlaceAdminStudioSpotlightArtistDto, {
        subprofileId: PERSONA_ID,
      }),
    ).toEqual([]);
    expect(
      await errorsFor(PlaceAdminStudioSpotlightArtistDto, {
        subprofileId: 'nope',
        note: 'x'.repeat(141),
      }),
    ).toEqual(['note', 'subprofileId']);
  });

  it('trims a note and takes null to clear it on an edit', async () => {
    const trimmed = plainToInstance(UpdateAdminStudioSpotlightArtistDto, {
      note: '  Out tonight  ',
    });
    expect(trimmed.note).toBe('Out tonight');
    expect(
      await errorsFor(UpdateAdminStudioSpotlightArtistDto, { note: null }),
    ).toEqual([]);
    expect(await errorsFor(UpdateAdminStudioSpotlightArtistDto, {})).toEqual([
      'note',
    ]);
  });

  it('takes up to 12 spotlight ids for a reorder', async () => {
    expect(
      await errorsFor(ReorderAdminStudioNewStarsDto, {
        spotlightIds: [PERSONA_ID],
      }),
    ).toEqual([]);
    expect(
      await errorsFor(ReorderAdminStudioNewStarsDto, {
        spotlightIds: Array.from({ length: 13 }, () => PERSONA_ID),
      }),
    ).toEqual(['spotlightIds']);
    expect(
      await errorsFor(ReorderAdminStudioNewStarsDto, {
        spotlightIds: ['not-a-uuid'],
      }),
    ).toEqual(['spotlightIds']);
  });

  it('takes a search term of 1 to 80 characters after trimming', async () => {
    expect(
      await errorsFor(AdminStudioSpotlightArtistSearchQuery, { q: '   ' }),
    ).toEqual(['q']);
    expect(await errorsFor(AdminStudioSpotlightArtistSearchQuery, {})).toEqual([
      'q',
    ]);
    expect(
      await errorsFor(AdminStudioSpotlightArtistSearchQuery, {
        q: 'x'.repeat(81),
      }),
    ).toEqual(['q']);
    const trimmed = plainToInstance(AdminStudioSpotlightArtistSearchQuery, {
      q: ' Lua ',
    });
    expect(trimmed.q).toBe('Lua');
    expect(await validate(trimmed)).toEqual([]);
  });
});
