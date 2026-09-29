import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { FEATURE_KEY } from '../common/feature.decorator';
import { isFeatureLaunched } from '../launchedFeatures';
import { GoTogetherEventController } from './go-together-event.controller';
import { GoTogetherGroupsController } from './go-together-groups.controller';
import {
  GoTogetherLaunchGuard,
  isGoTogetherLaunched,
} from './go-together-launch.guard';
import { GoTogetherProfileController } from './go-together-profile.controller';

// Only the lookup is replaced: the controllers' imports still see the real
// registry.
jest.mock('../launchedFeatures', () => ({
  ...jest.requireActual<typeof import('../launchedFeatures')>(
    '../launchedFeatures',
  ),
  isFeatureLaunched: jest.fn(),
}));

const mockIsFeatureLaunched = isFeatureLaunched as jest.MockedFunction<
  typeof isFeatureLaunched
>;

function launch(keys: { goTogether: boolean; events: boolean }): void {
  mockIsFeatureLaunched.mockImplementation((key) =>
    key === 'goTogether' || key === 'events' ? keys[key] : true,
  );
}

function guardsOf(target: object): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[]) ?? [];
}

/** Guards bound on one questionnaire handler, read off the prototype. */
function profileHandlerGuards(
  handlerName: 'getMine' | 'upsertMine' | 'deleteMine',
): unknown[] {
  const handler = Object.getOwnPropertyDescriptor(
    GoTogetherProfileController.prototype,
    handlerName,
  )?.value as object;
  return guardsOf(handler);
}

describe('isGoTogetherLaunched', () => {
  afterEach(() => jest.clearAllMocks());

  it.each([
    [true, true, true],
    [false, true, false],
    [true, false, false],
    [false, false, false],
  ])(
    'goTogether %s and events %s make Go together launched: %s',
    (goTogether, events, expected) => {
      launch({ goTogether, events });
      expect(isGoTogetherLaunched()).toBe(expected);
    },
  );
});

describe('GoTogetherLaunchGuard', () => {
  afterEach(() => jest.clearAllMocks());

  it('lets the request through while both keys are launched', () => {
    launch({ goTogether: true, events: true });
    expect(new GoTogetherLaunchGuard().canActivate()).toBe(true);
  });

  it.each([
    ['Go together is held dark', { goTogether: false, events: true }],
    ['gatherings are switched off', { goTogether: true, events: false }],
  ])('answers the feature 404 when %s', (_label, keys) => {
    launch(keys);
    const guard = new GoTogetherLaunchGuard();
    expect(() => guard.canActivate()).toThrow(NotFoundException);
    expect(() => guard.canActivate()).toThrow(
      'This feature is not available yet.',
    );
  });
});

describe('Go together controller gates', () => {
  it.each([
    ['GoTogetherEventController', GoTogetherEventController],
    ['GoTogetherGroupsController', GoTogetherGroupsController],
  ])('%s rides the goTogether key and both launch guards', (_name, target) => {
    expect(Reflect.getMetadata(FEATURE_KEY, target)).toBe('goTogether');
    expect(guardsOf(target)).toContain(GoTogetherLaunchGuard);
  });

  it('keeps reading and deleting questionnaire answers on events, and gates only saving them', () => {
    expect(Reflect.getMetadata(FEATURE_KEY, GoTogetherProfileController)).toBe(
      'events',
    );
    expect(guardsOf(GoTogetherProfileController)).not.toContain(
      GoTogetherLaunchGuard,
    );
    expect(profileHandlerGuards('upsertMine')).toContain(GoTogetherLaunchGuard);
    expect(profileHandlerGuards('getMine')).not.toContain(
      GoTogetherLaunchGuard,
    );
    expect(profileHandlerGuards('deleteMine')).not.toContain(
      GoTogetherLaunchGuard,
    );
  });
});
