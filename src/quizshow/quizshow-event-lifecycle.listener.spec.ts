import { QuizshowEventLifecycleListener } from './quizshow-event-lifecycle.listener';
import type { QuizshowRuntimeService } from './quizshow-runtime.service';

describe('QuizshowEventLifecycleListener', () => {
  const NOW = 1_800_000_000_000;
  let abandonSessionsOfEvents: jest.Mock;
  let abandonSessionsOfOwner: jest.Mock;
  let listener: QuizshowEventLifecycleListener;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    abandonSessionsOfEvents = jest.fn().mockResolvedValue(undefined);
    abandonSessionsOfOwner = jest.fn().mockResolvedValue(undefined);
    listener = new QuizshowEventLifecycleListener({
      abandonSessionsOfEvents,
      abandonSessionsOfOwner,
    } as unknown as QuizshowRuntimeService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('ends the open session of a cancelled event as abandoned', async () => {
    await listener.handleEventCancelled({ eventIds: ['event-1', 'event-2'] });
    expect(abandonSessionsOfEvents).toHaveBeenCalledWith(
      ['event-1', 'event-2'],
      NOW,
    );
  });

  it('ends the open session of an event being deleted', async () => {
    await listener.handleEventDeleting({ eventId: 'event-3' });
    expect(abandonSessionsOfEvents).toHaveBeenCalledWith(['event-3'], NOW);
  });

  it('abandons the open game sessions of an erased owner', async () => {
    await listener.handleOwnerErasing({ userId: 'owner-1' });
    expect(abandonSessionsOfOwner).toHaveBeenCalledWith('owner-1', NOW);
  });

  it("logs and swallows a failure while ending an owner's games", async () => {
    abandonSessionsOfOwner.mockRejectedValue(new Error('database is down'));
    const errorSpy = jest
      .spyOn(
        (listener as unknown as { logger: { error: () => void } }).logger,
        'error',
      )
      .mockImplementation(() => undefined);
    await expect(
      listener.handleOwnerErasing({ userId: 'owner-1' }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const firstCallArguments = (errorSpy.mock.calls as unknown[][])[0];
    if (firstCallArguments === undefined) {
      throw new Error('the error log was not called');
    }
    const loggedLine = String(firstCallArguments[0]);
    expect(loggedLine).not.toContain('owner-1');
    expect(loggedLine).not.toContain('database is down');
  });

  it('never throws', async () => {
    abandonSessionsOfEvents.mockRejectedValue(new Error('database is down'));
    jest
      .spyOn(
        (listener as unknown as { logger: { error: () => void } }).logger,
        'error',
      )
      .mockImplementation(() => undefined);
    await expect(
      listener.handleEventCancelled({ eventIds: ['event-1'] }),
    ).resolves.toBeUndefined();
    await expect(
      listener.handleEventDeleting({ eventId: 'event-1' }),
    ).resolves.toBeUndefined();
  });
});
