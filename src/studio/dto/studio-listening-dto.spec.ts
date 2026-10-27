import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RecordStudioPlayDto } from './record-studio-play.dto';
import { StudioArtistPlaysQuery } from './studio-artist-plays.query';
import { StudioListeningRangeQuery } from './studio-listening-range.query';
import { UpdateStudioSupporterDto } from './update-studio-supporter.dto';

const TRACK_ID = '3f0f6c0e-5d5b-4f0e-9a52-6c1f2f0b7a11';
const PERSONA_ID = '8a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d';

const failingFields = async (
  dtoClass: new () => object,
  body: Record<string, unknown>,
): Promise<string[]> =>
  (await validate(plainToInstance(dtoClass, body)))
    .map((error) => error.property)
    .sort();

describe('Studio listening request DTOs', () => {
  it('needs a uuid track id to record a play', async () => {
    expect(
      await failingFields(RecordStudioPlayDto, { trackId: TRACK_ID }),
    ).toEqual([]);
    expect(await failingFields(RecordStudioPlayDto, {})).toEqual(['trackId']);
    expect(
      await failingFields(RecordStudioPlayDto, { trackId: 'night-bus' }),
    ).toEqual(['trackId']);
  });

  it('accepts the three ranges or none', async () => {
    for (const range of ['4w', '6m', '12m']) {
      expect(await failingFields(StudioListeningRangeQuery, { range })).toEqual(
        [],
      );
    }
    expect(await failingFields(StudioListeningRangeQuery, {})).toEqual([]);
    expect(
      await failingFields(StudioListeningRangeQuery, { range: '1y' }),
    ).toEqual(['range']);
  });

  it('needs the shown-as key, a uuid or null', async () => {
    expect(
      await failingFields(UpdateStudioSupporterDto, {
        shownAsSubprofileId: null,
      }),
    ).toEqual([]);
    expect(
      await failingFields(UpdateStudioSupporterDto, {
        shownAsSubprofileId: PERSONA_ID,
      }),
    ).toEqual([]);
    expect(await failingFields(UpdateStudioSupporterDto, {})).toEqual([
      'shownAsSubprofileId',
    ]);
    expect(
      await failingFields(UpdateStudioSupporterDto, {
        shownAsSubprofileId: 'me',
      }),
    ).toEqual(['shownAsSubprofileId']);
  });

  it('accepts a 28-day window only', async () => {
    expect(await failingFields(StudioArtistPlaysQuery, { days: '28' })).toEqual(
      [],
    );
    expect(await failingFields(StudioArtistPlaysQuery, {})).toEqual([]);
    expect(await failingFields(StudioArtistPlaysQuery, { days: '7' })).toEqual([
      'days',
    ]);
  });
});
