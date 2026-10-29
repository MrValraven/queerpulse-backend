import { categoryForReasonCode } from '../transparency/transparency-response';
import { ReportSubjectType } from './entities/report.entity';
import {
  REASON_CODES,
  isReasonOfferedFor,
  reasonsFor,
} from './reason-catalogue';
import { deriveSeverity } from './report-severity';

describe('payment_never_confirmed reason', () => {
  it('is a member-selectable reason code', () => {
    expect(REASON_CODES).toContain('payment_never_confirmed');
  });

  it('is offered on personas, just before other, with its label', () => {
    const options = reasonsFor(ReportSubjectType.Subprofile);
    expect(options.map((option) => option.code).slice(-2)).toEqual([
      'payment_never_confirmed',
      'other',
    ]);
    expect(
      options.find((option) => option.code === 'payment_never_confirmed')
        ?.label,
    ).toBe('Took my payment and did not confirm it');
    expect(
      isReasonOfferedFor(
        ReportSubjectType.Subprofile,
        'payment_never_confirmed',
      ),
    ).toBe(true);
  });

  it.each([
    ReportSubjectType.Post,
    ReportSubjectType.Reply,
    ReportSubjectType.Member,
    ReportSubjectType.GroupListing,
  ])('is offered nowhere else, such as %s subjects', (subjectType) => {
    expect(isReasonOfferedFor(subjectType, 'payment_never_confirmed')).toBe(
      false,
    );
  });

  it('reviews in the medium band beside a funding scam', () => {
    expect(deriveSeverity('payment_never_confirmed')).toBe(
      deriveSeverity('funding_scam'),
    );
  });

  it('counts under other in the transparency report', () => {
    expect(categoryForReasonCode('payment_never_confirmed')).toBe('other');
  });
});
