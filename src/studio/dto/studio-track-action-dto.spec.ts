import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddStudioTrackWarningsDto } from './add-studio-track-warnings.dto';
import { MarkStudioTrackExplicitDto } from './mark-studio-track-explicit.dto';

const REPORT_ID = 'ce000000-0000-4000-8000-000000000001';

async function errorsFor(
  dtoClass: new () => object,
  body: object,
): Promise<string[]> {
  return (await validate(plainToInstance(dtoClass, body)))
    .map((error) => error.property)
    .sort();
}

describe('Studio staff track bodies', () => {
  it('takes mark-explicit with or without a report id', async () => {
    expect(await errorsFor(MarkStudioTrackExplicitDto, {})).toEqual([]);
    expect(
      await errorsFor(MarkStudioTrackExplicitDto, { reportId: REPORT_ID }),
    ).toEqual([]);
    expect(
      await errorsFor(MarkStudioTrackExplicitDto, { reportId: 'report-1' }),
    ).toEqual(['reportId']);
  });

  it('takes one to eight known warnings', async () => {
    expect(
      await errorsFor(AddStudioTrackWarningsDto, {
        warnings: ['police'],
        reportId: REPORT_ID,
      }),
    ).toEqual([]);
    for (const warnings of [
      [],
      ['gore'],
      null,
      'police',
      Array.from({ length: 9 }, () => 'police'),
    ]) {
      expect(await errorsFor(AddStudioTrackWarningsDto, { warnings })).toEqual([
        'warnings',
      ]);
    }
  });
});
