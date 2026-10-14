import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateStudioPlaybackDto } from './update-studio-playback.dto';

const failingFields = async (
  body: Record<string, unknown>,
): Promise<string[]> =>
  (await validate(plainToInstance(UpdateStudioPlaybackDto, body)))
    .map((error) => error.property)
    .sort();

describe('UpdateStudioPlaybackDto', () => {
  it('accepts any subset of the three settings, the empty body included', async () => {
    expect(await failingFields({})).toEqual([]);
    expect(await failingFields({ autoplayNext: false })).toEqual([]);
    expect(await failingFields({ hideExplicit: true })).toEqual([]);
    expect(await failingFields({ crossfadeSeconds: 0 })).toEqual([]);
    expect(
      await failingFields({
        autoplayNext: true,
        hideExplicit: false,
        crossfadeSeconds: 12,
      }),
    ).toEqual([]);
  });

  it('holds crossfade to whole seconds from 0 to 12', async () => {
    expect(await failingFields({ crossfadeSeconds: 13 })).toEqual([
      'crossfadeSeconds',
    ]);
    expect(await failingFields({ crossfadeSeconds: -1 })).toEqual([
      'crossfadeSeconds',
    ]);
    expect(await failingFields({ crossfadeSeconds: 2.5 })).toEqual([
      'crossfadeSeconds',
    ]);
  });

  // `null` would reach a NOT NULL column as a 500; it answers 400 here.
  it('refuses null for every field', async () => {
    expect(
      await failingFields({
        autoplayNext: null,
        hideExplicit: null,
        crossfadeSeconds: null,
      }),
    ).toEqual(['autoplayNext', 'crossfadeSeconds', 'hideExplicit']);
  });

  it('refuses a string where a boolean or a number belongs', async () => {
    expect(
      await failingFields({ hideExplicit: 'true', crossfadeSeconds: '6' }),
    ).toEqual(['crossfadeSeconds', 'hideExplicit']);
  });
});
