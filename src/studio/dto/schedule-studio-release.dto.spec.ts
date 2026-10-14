import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ScheduleStudioReleaseDto } from './schedule-studio-release.dto';

const errorsFor = async (body: object): Promise<string[]> =>
  (await validate(plainToInstance(ScheduleStudioReleaseDto, body))).map(
    (error) => error.property,
  );

describe('ScheduleStudioReleaseDto', () => {
  it.each([
    '2026-10-20T18:00:00.000Z',
    '2026-10-20T18:00:00Z',
    '2026-10-20T19:00:00+01:00',
  ])('accepts %s', async (publishAt) => {
    expect(await errorsFor({ publishAt })).toEqual([]);
  });

  it.each([
    ['a time with no offset', '2026-10-20T18:00:00'],
    ['a date alone', '2026-10-20'],
    ['words', 'next friday'],
    ['a number', 1760983200000],
  ])('refuses %s', async (_label, publishAt) => {
    expect(await errorsFor({ publishAt })).toEqual(['publishAt']);
  });

  it('needs the field', async () => {
    expect(await errorsFor({})).toEqual(['publishAt']);
  });
});
