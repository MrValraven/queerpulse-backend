import { categoryForReasonCode } from '../transparency/transparency-response';
import { ReportSubjectType } from './entities/report.entity';
import {
  REASON_CODES,
  isReasonOfferedFor,
  reasonsFor,
} from './reason-catalogue';
import { deriveSeverity } from './report-severity';

describe('funding_scam reason', () => {
  it('is a member-selectable reason code', () => {
    expect(REASON_CODES).toContain('funding_scam');
  });

  it('is offered on posts, just before other, with its label', () => {
    const postOptions = reasonsFor(ReportSubjectType.Post);
    const codes = postOptions.map((option) => option.code);
    expect(codes.slice(-2)).toEqual(['funding_scam', 'other']);
    expect(
      postOptions.find((option) => option.code === 'funding_scam')?.label,
    ).toBe('Scam or fake fundraiser or grant');
    expect(isReasonOfferedFor(ReportSubjectType.Post, 'funding_scam')).toBe(
      true,
    );
  });

  it('is offered on replies, just before other, after the rest of the reply set', () => {
    const codes = reasonsFor(ReportSubjectType.Reply).map(
      (option) => option.code,
    );
    expect(codes).toEqual([
      'outing',
      'doxxing',
      'harassment',
      'hate_speech',
      'discrimination',
      'spam',
      'off_topic',
      'funding_scam',
      'other',
    ]);
    expect(isReasonOfferedFor(ReportSubjectType.Reply, 'funding_scam')).toBe(
      true,
    );
  });

  it.each([ReportSubjectType.Member, ReportSubjectType.GroupListing])(
    'stays off %s subjects',
    (subjectType) => {
      expect(isReasonOfferedFor(subjectType, 'funding_scam')).toBe(false);
    },
  );

  it('shares the housing scam severity band and public category', () => {
    expect(deriveSeverity('funding_scam')).toBe(deriveSeverity('housing_scam'));
    expect(categoryForReasonCode('funding_scam')).toBe(
      categoryForReasonCode('housing_scam'),
    );
  });
});
