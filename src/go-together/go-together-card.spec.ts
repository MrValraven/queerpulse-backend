import { computeCardState, CardInput } from './go-together-card';

const base: CardInput = {
  eventBlocker: null,
  memberBlocker: null,
  hasUsableProfile: true,
  entry: null,
  hasIncomingPairInvite: false,
  isFeedbackOpen: false,
  isFinalPassDone: false,
};

describe('computeCardState', () => {
  it('hides the card when the host has not enabled Go together', () => {
    expect(
      computeCardState({ ...base, eventBlocker: 'notEnabled' }).state,
    ).toBe('unavailable');
  });

  it('keeps showing the group to a grouped member even after opt-in closed', () => {
    expect(
      computeCardState({
        ...base,
        eventBlocker: 'closed',
        entry: { status: 'grouped' },
      }).state,
    ).toBe('grouped');
  });

  it('switches a grouped member to feedback once the window opens', () => {
    expect(
      computeCardState({
        ...base,
        entry: { status: 'grouped' },
        isFeedbackOpen: true,
      }).state,
    ).toBe('feedbackDue');
  });

  it('explains ineligibility with its reason', () => {
    expect(computeCardState({ ...base, memberBlocker: 'notVerified' })).toEqual(
      { state: 'ineligible', reason: 'notVerified' },
    );
  });

  it('shows waiting and unmatched entries', () => {
    expect(
      computeCardState({ ...base, entry: { status: 'waiting' } }).state,
    ).toBe('waiting');
    expect(
      computeCardState({ ...base, entry: { status: 'unmatched' } }).state,
    ).toBe('unmatched');
  });

  it('puts an incoming pair invite ahead of the opt-in choice', () => {
    expect(
      computeCardState({ ...base, hasIncomingPairInvite: true }).state,
    ).toBe('pairInvite');
  });

  it('asks for the questionnaire before the opt-in choice', () => {
    expect(computeCardState({ ...base, hasUsableProfile: false }).state).toBe(
      'questionnaireNeeded',
    );
    expect(computeCardState(base).state).toBe('notOptedIn');
  });

  it('keeps the group card for a grouped member when the switch reads off', () => {
    expect(
      computeCardState({
        ...base,
        eventBlocker: 'notEnabled',
        entry: { status: 'grouped' },
      }).state,
    ).toBe('grouped');
    expect(
      computeCardState({
        ...base,
        eventBlocker: 'notEnabled',
        entry: { status: 'grouped' },
        isFeedbackOpen: true,
      }).state,
    ).toBe('feedbackDue');
  });

  it('still hides the group card of a gathering that is no longer published', () => {
    expect(
      computeCardState({
        ...base,
        eventBlocker: 'eventNotPublished',
        entry: { status: 'grouped' },
      }).state,
    ).toBe('unavailable');
  });

  it('shows closed to an unmatched member once the final late-group pass has run', () => {
    expect(
      computeCardState({
        ...base,
        eventBlocker: 'closed',
        entry: { status: 'unmatched' },
        isFinalPassDone: true,
      }),
    ).toEqual({ state: 'closed', reason: null });
  });

  it('keeps an unmatched member on unmatched while the final pass is still to run', () => {
    expect(
      computeCardState({
        ...base,
        eventBlocker: 'closed',
        entry: { status: 'unmatched' },
      }).state,
    ).toBe('unmatched');
  });

  it('keeps closed after the final pass when the gathering moved later', () => {
    // A later start reopens opt-in (no `closed` blocker), but the final pass
    // stays done and no more matching runs.
    expect(
      computeCardState({
        ...base,
        entry: { status: 'unmatched' },
        isFinalPassDone: true,
      }).state,
    ).toBe('closed');
  });

  it('shows closed to a member who never opted in once opt-in closed', () => {
    expect(computeCardState({ ...base, eventBlocker: 'closed' }).state).toBe(
      'closed',
    );
  });
});
