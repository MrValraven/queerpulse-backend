import { NotificationPushThrottleService } from './notification-push-throttle.service';

const WINDOW_MS = 15 * 60 * 1000;
const START = new Date('2026-11-23T10:00:00.000Z');

describe('NotificationPushThrottleService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('suppresses a second push for the same bucket inside the window', () => {
    const throttle = new NotificationPushThrottleService();

    expect(throttle.allowedRecipients(['user-1'], 'alert', WINDOW_MS)).toEqual([
      'user-1',
    ]);
    expect(throttle.allowedRecipients(['user-1'], 'alert', WINDOW_MS)).toEqual(
      [],
    );
  });

  // PRD-512: the push fatigue cap mints one bucket per subject, so the whole
  // family must be pruned, or a subject asked about once stays forever.
  it('prunes every expired bucket of a family when the family prefix is named', () => {
    const throttle = new NotificationPushThrottleService();
    for (const subject of ['thread-a', 'thread-b', 'thread-c']) {
      throttle.allowedRecipients(
        ['user-1', 'user-2'],
        `push-fatigue:${subject}`,
        WINDOW_MS,
        'push-fatigue:',
      );
    }
    expect(throttle.trackedEntryCount()).toBe(6);

    jest.setSystemTime(START.getTime() + WINDOW_MS);
    throttle.allowedRecipients(
      ['user-3'],
      'push-fatigue:thread-d',
      WINDOW_MS,
      'push-fatigue:',
    );

    expect(throttle.trackedEntryCount()).toBe(1);
  });

  it("leaves another family's entries alone", () => {
    const throttle = new NotificationPushThrottleService();
    throttle.allowedRecipients(['user-1'], 'queue:alert', 60 * 60 * 1000);
    throttle.allowedRecipients(
      ['user-1'],
      'push-fatigue:thread-a',
      WINDOW_MS,
      'push-fatigue:',
    );

    jest.setSystemTime(START.getTime() + WINDOW_MS);
    throttle.allowedRecipients(
      ['user-2'],
      'push-fatigue:thread-b',
      WINDOW_MS,
      'push-fatigue:',
    );

    // `queue:alert` and the fresh `thread-b` entry remain.
    expect(throttle.trackedEntryCount()).toBe(2);
  });

  it('keeps unexpired family entries suppressing', () => {
    const throttle = new NotificationPushThrottleService();
    throttle.allowedRecipients(
      ['user-1'],
      'push-fatigue:thread-a',
      WINDOW_MS,
      'push-fatigue:',
    );

    jest.setSystemTime(START.getTime() + WINDOW_MS - 1);
    throttle.allowedRecipients(
      ['user-2'],
      'push-fatigue:thread-b',
      WINDOW_MS,
      'push-fatigue:',
    );

    expect(
      throttle.allowedRecipients(
        ['user-1'],
        'push-fatigue:thread-a',
        WINDOW_MS,
        'push-fatigue:',
      ),
    ).toEqual([]);
  });
});
