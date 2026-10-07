// The listener imports `ChatGateway` as its injection token, which loads the
// ESM-only `cookie` package and Sentry; stubbed the way the gateway's own
// specs stub them.
jest.mock('cookie', () => ({ parseCookie: jest.fn(() => ({})) }));
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

import {
  EVENT_DOOR_CHANGED,
  EventDoorChangedEvent,
  GATHERING_CHECKIN_FRAME,
} from '../events/event.events';
import { GatheringDoorRelayListener } from './gathering-door-relay.listener';

/**
 * The `gathering:checkin` frame tells a door device to refetch. It reaches the
 * organisers the service named, each through their own `user:` room, and
 * carries the gathering slug, the member slug and the change only.
 */
function makeListener(options: { isNamespaceMissing?: boolean } = {}) {
  const emits: Array<{ room: string; frameName: string; frame: unknown }> = [];
  const namespace = {
    to: jest.fn((room: string) => ({
      emit: (frameName: string, frame: unknown) => {
        emits.push({ room, frameName, frame });
        return true;
      },
    })),
  };
  const chatGateway = {
    namespace: options.isNamespaceMissing ? undefined : namespace,
  };
  const listener = new GatheringDoorRelayListener(chatGateway as never);
  return { listener, emits };
}

const doorEvent = (
  overrides: Partial<EventDoorChangedEvent> = {},
): EventDoorChangedEvent => ({
  eventSlug: 'rooftop-supper',
  memberSlug: 'mara',
  change: 'checked_in',
  organizerUserIds: ['host-1', 'cohost-1'],
  ...overrides,
});

describe('GatheringDoorRelayListener', () => {
  it('listens for the domain event the check-in service emits', () => {
    expect(EVENT_DOOR_CHANGED).toBe('event.door.changed');
  });

  it('sends the frame to each organiser user room and to no other room', () => {
    const { listener, emits } = makeListener();
    listener.handleDoorChanged(doorEvent());
    expect(emits.map((emit) => emit.room)).toEqual([
      'user:host-1',
      'user:cohost-1',
    ]);
    expect(
      emits.every((emit) => emit.frameName === GATHERING_CHECKIN_FRAME),
    ).toBe(true);
  });

  it('carries only the gathering slug, the member slug and the change', () => {
    const { listener, emits } = makeListener();
    listener.handleDoorChanged(doorEvent({ change: 'undone' }));
    expect(emits.map((emit) => emit.frame)[0]).toEqual({
      eventSlug: 'rooftop-supper',
      memberSlug: 'mara',
      change: 'undone',
    });
  });

  it('addresses a repeated organiser once', () => {
    const { listener, emits } = makeListener();
    listener.handleDoorChanged(
      doorEvent({ organizerUserIds: ['host-1', 'host-1'] }),
    );
    expect(emits).toHaveLength(1);
  });

  it('sends nothing when the event names no organiser', () => {
    const { listener, emits } = makeListener();
    listener.handleDoorChanged(doorEvent({ organizerUserIds: [] }));
    expect(emits).toHaveLength(0);
  });

  it('does nothing before the gateway namespace exists', () => {
    const { listener, emits } = makeListener({ isNamespaceMissing: true });
    expect(() => listener.handleDoorChanged(doorEvent())).not.toThrow();
    expect(emits).toHaveLength(0);
  });
});
