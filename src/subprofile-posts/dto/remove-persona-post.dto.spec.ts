import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PERSONA_POST_REMOVAL_REASON_MAX } from '../persona-post.constants';
import { RemovePersonaPostDto } from './remove-persona-post.dto';

const validationErrorsFor = async (reason: unknown) =>
  validate(plainToInstance(RemovePersonaPostDto, { reason }));

describe('RemovePersonaPostDto', () => {
  it('trims the reason', () => {
    const dto = plainToInstance(RemovePersonaPostDto, {
      reason: '  Harassment  ',
    });
    expect(dto.reason).toBe('Harassment');
  });

  it('accepts a reason of one character and one of the maximum length', async () => {
    expect(await validationErrorsFor('x')).toHaveLength(0);
    expect(
      await validationErrorsFor('x'.repeat(PERSONA_POST_REMOVAL_REASON_MAX)),
    ).toHaveLength(0);
  });

  it('rejects an empty or whitespace-only reason', async () => {
    expect(await validationErrorsFor('')).not.toHaveLength(0);
    expect(await validationErrorsFor('   ')).not.toHaveLength(0);
  });

  it('rejects a reason over the maximum length', async () => {
    expect(
      await validationErrorsFor(
        'x'.repeat(PERSONA_POST_REMOVAL_REASON_MAX + 1),
      ),
    ).not.toHaveLength(0);
  });

  it('rejects a missing or non-string reason', async () => {
    expect(await validationErrorsFor(undefined)).not.toHaveLength(0);
    expect(await validationErrorsFor(42)).not.toHaveLength(0);
  });

  it('takes an optional report id, a uuid when present', async () => {
    const withReport = async (reportId: unknown) =>
      validate(
        plainToInstance(RemovePersonaPostDto, {
          reason: 'Harassment',
          reportId,
        }),
      );
    expect(await withReport(undefined)).toHaveLength(0);
    expect(
      await withReport('e1000000-0000-4000-8000-000000000010'),
    ).toHaveLength(0);
    expect(await withReport('report-1')).not.toHaveLength(0);
    expect(await withReport(42)).not.toHaveLength(0);
  });
});
