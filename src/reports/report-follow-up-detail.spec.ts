import {
  FOLLOW_UP_HEADING_PATTERN,
  REPEATED_ACCOUNT_SQL,
  followUpHeading,
  isRepeatedAccount,
  reportDetailAccounts,
} from './report-follow-up-detail';

/**
 * PRD-510 retry test: a repeat filing is a retry only when its account equals
 * one the open report already holds as a whole.
 */

const FIRST_ACCOUNT = 'He followed me home after the event and did it again.';
const ADDED_AT = new Date('2026-11-23T09:30:00.000Z');

function withFollowUp(detail: string, account: string): string {
  const block = `${followUpHeading(ADDED_AT)}\n${account}`;
  return detail ? `${detail}\n\n${block}` : block;
}

describe('report follow-up accounts (PRD-510)', () => {
  it('splits a stored detail into the first account and each added one', () => {
    const detail = withFollowUp(
      withFollowUp(FIRST_ACCOUNT, 'It happened again tonight.'),
      'Line one\n\nline two of the same account',
    );

    expect(reportDetailAccounts(detail)).toEqual([
      FIRST_ACCOUNT,
      'It happened again tonight.',
      'Line one\n\nline two of the same account',
    ]);
  });

  it('reads a report filed with no words as an empty first account', () => {
    const detail = withFollowUp('', 'It happened again tonight.');

    expect(reportDetailAccounts(detail)).toEqual([
      '',
      'It happened again tonight.',
    ]);
    expect(reportDetailAccounts(null)).toEqual(['']);
  });

  it('treats a repeat of the first account or an added one as a retry', () => {
    const detail = withFollowUp(FIRST_ACCOUNT, 'It happened again tonight.');

    expect(isRepeatedAccount(detail, FIRST_ACCOUNT)).toBe(true);
    expect(isRepeatedAccount(detail, 'It happened again tonight.')).toBe(true);
  });

  it('keeps a short follow-up that only appears inside a longer account', () => {
    const detail = withFollowUp(FIRST_ACCOUNT, 'It happened again tonight.');

    expect(isRepeatedAccount(detail, 'did it again')).toBe(false);
    expect(isRepeatedAccount(detail, 'again')).toBe(false);
    expect(isRepeatedAccount(detail, 'tonight.')).toBe(false);
  });

  it('matches the heading this module writes', () => {
    expect(
      new RegExp(FOLLOW_UP_HEADING_PATTERN).test(
        `\n\n${followUpHeading(ADDED_AT)}\n`,
      ),
    ).toBe(true);
  });

  it('runs the same whole-account test in SQL', () => {
    expect(REPEATED_ACCOUNT_SQL).toContain('regexp_split_to_table');
    expect(REPEATED_ACCOUNT_SQL).toContain(':followUpHeadingPattern');
    expect(REPEATED_ACCOUNT_SQL).not.toContain('position(');
  });
});
