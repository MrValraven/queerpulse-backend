import { StudioPlayGate } from './studio-play-gate';

const MEMBER = '11111111-1111-4111-8111-111111111111';
const OTHER_MEMBER = '22222222-2222-4222-8222-222222222222';

describe('StudioPlayGate', () => {
  let gate: StudioPlayGate;

  beforeEach(() => {
    gate = new StudioPlayGate();
  });

  it('admits the first call and refuses a second inside 25 seconds', () => {
    expect([
      gate.admit(MEMBER, 0),
      gate.admit(MEMBER, 24_999),
      gate.admit(MEMBER, 50_000),
    ]).toEqual(['admitted', 'too_soon', 'admitted']);
  });

  it('claims the slot synchronously, so a second call in the same millisecond is too soon', () => {
    expect([gate.admit(MEMBER, 1000), gate.admit(MEMBER, 1000)]).toEqual([
      'admitted',
      'too_soon',
    ]);
  });

  it('throttles the fifth call inside a rolling minute', () => {
    expect(
      [0, 1000, 2000, 3000, 4000].map((time) => gate.admit(MEMBER, time)),
    ).toEqual(['admitted', 'too_soon', 'too_soon', 'too_soon', 'throttled']);
  });

  it('admits again once the minute has rolled past every earlier call', () => {
    for (const time of [0, 1000, 2000, 3000, 4000]) gate.admit(MEMBER, time);
    expect(gate.admit(MEMBER, 64_001)).toBe('admitted');
  });

  it('keeps each member on their own slot', () => {
    expect([gate.admit(MEMBER, 0), gate.admit(OTHER_MEMBER, 0)]).toEqual([
      'admitted',
      'admitted',
    ]);
  });

  it('drops every entry older than a minute', () => {
    gate.admit(MEMBER, 0);
    gate.dropExpiredEntries(60_001);
    expect(gate.trackedMemberCount()).toBe(0);
  });
});
