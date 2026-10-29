import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { STUDIO_GENRES, STUDIO_MOODS } from '../../studio/studio.constants';
import { UpdateStudioWelcomeDto } from './update-studio-welcome.dto';

const failingFields = async (
  body: Record<string, unknown>,
): Promise<string[]> =>
  (await validate(plainToInstance(UpdateStudioWelcomeDto, body)))
    .map((error) => error.property)
    .sort();

describe('UpdateStudioWelcomeDto', () => {
  it('accepts any subset of the three fields, the empty body included', async () => {
    expect(await failingFields({})).toEqual([]);
    expect(await failingFields({ hasSeenWelcome: true })).toEqual([]);
    expect(await failingFields({ genres: ['fado', 'jazz'] })).toEqual([]);
    expect(await failingFields({ moods: ['tender'] })).toEqual([]);
    expect(
      await failingFields({
        hasSeenWelcome: true,
        genres: ['pop'],
        moods: ['calm', 'dreamy'],
      }),
    ).toEqual([]);
  });

  it('accepts hasSeenWelcome as true only', async () => {
    for (const value of [false, null, 'true', 1]) {
      expect(await failingFields({ hasSeenWelcome: value })).toEqual([
        'hasSeenWelcome',
      ]);
    }
  });

  it('accepts empty lists so a member can clear a pick', async () => {
    expect(await failingFields({ genres: [], moods: [] })).toEqual([]);
  });

  it('accepts every known genre and every known mood at once', async () => {
    expect(
      await failingFields({
        genres: [...STUDIO_GENRES],
        moods: [...STUDIO_MOODS],
      }),
    ).toEqual([]);
  });

  it('refuses a genre or a mood outside the known lists', async () => {
    expect(await failingFields({ genres: ['polka'] })).toEqual(['genres']);
    expect(await failingFields({ moods: ['furious'] })).toEqual(['moods']);
    expect(await failingFields({ genres: ['fado', 'polka'] })).toEqual([
      'genres',
    ]);
  });

  it('refuses duplicate picks', async () => {
    expect(await failingFields({ genres: ['fado', 'fado'] })).toEqual([
      'genres',
    ]);
    expect(await failingFields({ moods: ['calm', 'calm'] })).toEqual(['moods']);
  });

  it('refuses null and non-array values for the lists', async () => {
    expect(await failingFields({ genres: null, moods: null })).toEqual([
      'genres',
      'moods',
    ]);
    expect(await failingFields({ genres: 'fado', moods: 'calm' })).toEqual([
      'genres',
      'moods',
    ]);
  });
});
