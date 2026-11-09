import { randomUUID } from 'node:crypto';
import type { VjStageFrame } from './vj.contract';
import { EMPTY_VJ_LOOKUP_RESULTS } from './stage/vj-rule-kit';
import type { VjStageReadsService } from './vj-stage-reads.service';
import { VjStageService } from './vj-stage.service';

const OWNER_USER_ID = randomUUID();
const OTHER_OWNER_USER_ID = randomUUID();
const FIRST_SCREEN_ID = randomUUID();
const SECOND_SCREEN_ID = randomUUID();

function createService() {
  const reads = {
    readPackForStage: jest.fn().mockResolvedValue({ eventId: null }),
    existingClipIds: jest
      .fn()
      .mockImplementation((clipIds: string[]) =>
        Promise.resolve(new Set(clipIds)),
      ),
    clipIdsInPack: jest
      .fn()
      .mockImplementation((_packId: string, clipIds: string[]) =>
        Promise.resolve(new Set(clipIds)),
      ),
    readPackClipForAdvance: jest.fn().mockResolvedValue({ isFavorite: false }),
    readSceneLook: jest.fn().mockResolvedValue(null),
    readSetlistItem: jest.fn().mockResolvedValue(null),
    setlistItemCount: jest.fn().mockResolvedValue(null),
  };
  const service = new VjStageService(reads as unknown as VjStageReadsService);
  const broadcasts: { adminUserId: string; frame: VjStageFrame }[] = [];
  service.bindBroadcaster({
    broadcastState: (adminUserId, frame) => {
      broadcasts.push({ adminUserId, frame });
    },
  });
  return { service, broadcasts };
}

function attachScreen(
  service: VjStageService,
  adminUserId: string,
  socketId: string,
  screenId: string,
  now: number,
) {
  const outcome = service.attachScreen(
    {
      adminUserId,
      socketId,
      screenId,
      restoreState: null,
      restoreReads: null,
    },
    now,
  );
  expect(outcome.ok).toBe(true);
  return outcome;
}

/** A valid status report with the given fullscreen flag and renderer. */
function statusPayload(
  isFullscreen: boolean,
  renderer: 'webgl2' | 'dom' | null,
): Record<string, unknown> {
  return {
    isFullscreen,
    preload: { packId: null, clips: [] },
    health:
      renderer === null
        ? null
        : {
            renderer,
            fps: 60,
            droppedFrames: 0,
            cacheBytes: 0,
            isEffectLoadHigh: false,
          },
  };
}

describe('VjStageService live connection reads', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('lists no stage when nothing is in memory', () => {
    const { service } = createService();
    expect(service.liveStages(null)).toEqual([]);
    expect(service.idleStageCount(null)).toBe(0);
  });

  it('lists connected screens by number with the lead, attach time and unknown status', () => {
    const { service } = createService();
    attachScreen(service, OWNER_USER_ID, 'socket-a', FIRST_SCREEN_ID, 100);
    attachScreen(service, OWNER_USER_ID, 'socket-b', SECOND_SCREEN_ID, 200);
    service.attachRemote(OWNER_USER_ID, 'socket-remote', 300);

    expect(service.liveStages(null)).toEqual([
      {
        adminUserId: OWNER_USER_ID,
        screens: [
          {
            socketId: 'socket-a',
            number: 1,
            isLead: true,
            connectedAt: 100,
            isFullscreen: null,
            renderer: null,
          },
          {
            socketId: 'socket-b',
            number: 2,
            isLead: false,
            connectedAt: 200,
            isFullscreen: null,
            renderer: null,
          },
        ],
        attachedSocketIds: ['socket-a', 'socket-b', 'socket-remote'],
      },
    ]);
  });

  it('reads the fullscreen flag and renderer once a status report is stored', () => {
    const { service } = createService();
    attachScreen(service, OWNER_USER_ID, 'socket-a', FIRST_SCREEN_ID, 100);
    service.updateScreenStatus(
      OWNER_USER_ID,
      'socket-a',
      statusPayload(true, 'webgl2'),
      150,
    );

    const [stage] = service.liveStages(OWNER_USER_ID);
    expect(stage?.screens[0]).toMatchObject({
      isFullscreen: true,
      renderer: 'webgl2',
    });
  });

  it('forgets the reported status when the screen reconnects on a new socket', () => {
    const { service } = createService();
    attachScreen(service, OWNER_USER_ID, 'socket-a', FIRST_SCREEN_ID, 100);
    service.updateScreenStatus(
      OWNER_USER_ID,
      'socket-a',
      statusPayload(true, 'dom'),
      150,
    );
    service.detachSocket(OWNER_USER_ID, 'socket-a', 200);
    attachScreen(service, OWNER_USER_ID, 'socket-a2', FIRST_SCREEN_ID, 300);

    const [stage] = service.liveStages(OWNER_USER_ID);
    expect(stage?.screens).toEqual([
      {
        socketId: 'socket-a2',
        number: 1,
        isLead: true,
        connectedAt: 300,
        isFullscreen: null,
        renderer: null,
      },
    ]);
  });

  it('leaves offline screens out and counts a stage with no attached socket as idle', () => {
    const { service } = createService();
    attachScreen(service, OWNER_USER_ID, 'socket-a', FIRST_SCREEN_ID, 100);
    service.detachSocket(OWNER_USER_ID, 'socket-a', 200);
    service.attachRemote(OTHER_OWNER_USER_ID, 'socket-remote', 300);

    expect(service.liveStages(OWNER_USER_ID)).toEqual([
      { adminUserId: OWNER_USER_ID, screens: [], attachedSocketIds: [] },
    ]);
    expect(service.idleStageCount(null)).toBe(1);
    expect(service.idleStageCount(OWNER_USER_ID)).toBe(1);
    expect(service.idleStageCount(OTHER_OWNER_USER_ID)).toBe(0);
  });

  it('reads one owner when a user id is given and every owner for null', () => {
    const { service } = createService();
    service.attachRemote(OWNER_USER_ID, 'socket-own', 100);
    service.attachRemote(OTHER_OWNER_USER_ID, 'socket-other', 100);

    expect(
      service.liveStages(OWNER_USER_ID).map((stage) => stage.adminUserId),
    ).toEqual([OWNER_USER_ID]);
    expect(
      service
        .liveStages(null)
        .map((stage) => stage.adminUserId)
        .sort(),
    ).toEqual([OWNER_USER_ID, OTHER_OWNER_USER_ID].sort());
  });
});

describe('VjStageService.dropStage', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('drops an attached stage at once and answers true', () => {
    const { service } = createService();
    attachScreen(service, OWNER_USER_ID, 'socket-a', FIRST_SCREEN_ID, 100);

    expect(service.dropStage(OWNER_USER_ID)).toBe(true);
    expect(service.getState(OWNER_USER_ID)).toBeNull();
    expect(service.liveStages(null)).toEqual([]);
  });

  it('answers false for an owner with no stage in memory', () => {
    const { service } = createService();
    expect(service.dropStage(OWNER_USER_ID)).toBe(false);
  });

  it('leaves the other owners stages in memory', () => {
    const { service } = createService();
    service.attachRemote(OWNER_USER_ID, 'socket-own', 100);
    service.attachRemote(OTHER_OWNER_USER_ID, 'socket-other', 100);

    service.dropStage(OWNER_USER_ID);

    expect(service.getState(OWNER_USER_ID)).toBeNull();
    expect(service.getState(OTHER_OWNER_USER_ID)).not.toBeNull();
  });

  it('clears the stage timers so a dropped strobe, overlay or countdown never broadcasts', () => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    const { service, broadcasts } = createService();
    service.attachRemote(OWNER_USER_ID, 'socket-remote', 10_000);
    const clientId = randomUUID();
    const commands: [
      Parameters<VjStageService['applyRemoteCommand']>[1],
      Record<string, unknown>,
    ][] = [
      ['stage:setStrobe', { isStrobing: true }],
      [
        'stage:setOverlay',
        { text: 'Hello', isVisible: true, hideAfterMs: 5000 },
      ],
      ['stage:setCountdown', { isVisible: true, durationMs: 5000 }],
    ];
    commands.forEach(([name, fields], position) => {
      const outcome = service.applyRemoteCommand(
        OWNER_USER_ID,
        name,
        { ...fields, clientId, commandSequence: position + 1 },
        EMPTY_VJ_LOOKUP_RESULTS,
        Date.now(),
      );
      expect(outcome.ok).toBe(true);
    });
    expect(jest.getTimerCount()).toBe(3);

    service.dropStage(OWNER_USER_ID);

    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(60_000);
    expect(broadcasts).toEqual([]);
  });

  it('lets a later attach start a fresh stage', () => {
    const { service } = createService();
    attachScreen(service, OWNER_USER_ID, 'socket-a', FIRST_SCREEN_ID, 100);
    const firstEpoch = service.getState(OWNER_USER_ID)?.stageEpoch;

    service.dropStage(OWNER_USER_ID);
    const outcome = attachScreen(
      service,
      OWNER_USER_ID,
      'socket-b',
      FIRST_SCREEN_ID,
      200,
    );

    expect(outcome.ok && outcome.screenNumber).toBe(1);
    expect(service.getState(OWNER_USER_ID)?.stageEpoch).not.toBe(firstEpoch);
  });
});
