import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateStudioReleaseVersionDto } from './create-studio-release-version.dto';

const errorsFor = async (body: object): Promise<string[]> =>
  (await validate(plainToInstance(CreateStudioReleaseVersionDto, body))).map(
    (error) => error.property,
  );

describe('CreateStudioReleaseVersionDto', () => {
  it('trims the note and keeps up to 280 characters', async () => {
    const body = plainToInstance(CreateStudioReleaseVersionDto, {
      note: '  Added a bonus track  ',
    });
    expect(body.note).toBe('Added a bonus track');
    expect(await errorsFor({ note: 'x'.repeat(280) })).toEqual([]);
  });

  it.each([
    ['a blank note', '   '],
    ['281 characters', 'x'.repeat(281)],
    ['a number', 2],
  ])('refuses %s', async (_label, note) => {
    expect(await errorsFor({ note })).toEqual(['note']);
  });
});
