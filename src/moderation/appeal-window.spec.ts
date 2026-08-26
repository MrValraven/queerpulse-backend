import {
  APPEAL_DECISION_WINDOW_DAYS,
  APPEAL_FILING_WINDOW_DAYS,
  appealDecisionDueAt,
  appealFilingWindowClosesAt,
  isWithinAppealFilingWindow,
} from './appeal-window';

/**
 * The two windows Code of Conduct §05 publishes. Pure arithmetic, so these
 * tests are the cheapest possible guard against the published text and the
 * software drifting apart: change one number here and a test names the other.
 */
describe('appeal-window', () => {
  const decisionTakenAt = new Date('2026-03-01T12:00:00.000Z');

  it('publishes the windows §05 states', () => {
    expect(APPEAL_FILING_WINDOW_DAYS).toBe(14);
    expect(APPEAL_DECISION_WINDOW_DAYS).toBe(7);
  });

  it('closes the filing window 14 days after the decision was taken', () => {
    expect(appealFilingWindowClosesAt(decisionTakenAt).toISOString()).toBe(
      '2026-03-15T12:00:00.000Z',
    );
  });

  it('gives a filed appeal 7 days to be decided', () => {
    expect(appealDecisionDueAt(decisionTakenAt).toISOString()).toBe(
      '2026-03-08T12:00:00.000Z',
    );
  });

  it('accepts a filing inside the window', () => {
    expect(
      isWithinAppealFilingWindow(
        decisionTakenAt,
        new Date('2026-03-14T23:59:00.000Z'),
      ),
    ).toBe(true);
  });

  // A window a member is told is 14 days long must not refuse them on a
  // millisecond, so the boundary is inclusive.
  it('accepts a filing at exactly the closing instant', () => {
    expect(
      isWithinAppealFilingWindow(
        decisionTakenAt,
        new Date('2026-03-15T12:00:00.000Z'),
      ),
    ).toBe(true);
  });

  it('refuses a filing after the window closed', () => {
    expect(
      isWithinAppealFilingWindow(
        decisionTakenAt,
        new Date('2026-03-15T12:00:00.001Z'),
      ),
    ).toBe(false);
  });
});
