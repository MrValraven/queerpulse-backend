import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  createVjStageState,
  VJ_LIMITS,
  vjSceneLookOf,
  vjSetlistSelectReadPosition,
  type VjAckFailure,
  type VjLibraryChange,
  type VjRemoteCommandName,
  type VjSceneLook,
  type VjScreenClipStatus,
  type VjSetlistFollowRead,
  type VjSetlistRead,
  type VjSetlistReadPosition,
  type VjSetlistStepRead,
  type VjStageFrame,
  type VjStageState,
} from './vj.contract';
import {
  EMPTY_VJ_LOOKUP_RESULTS,
  vjPackClipKey,
  vjSetlistItemKey,
  type VjLookupResults,
} from './stage/vj-rule-kit';
import type { VjStageReadsService } from './vj-stage-reads.service';
import {
  VJ_CLIENT_SEQUENCE_MEMORY,
  VJ_SCREEN_OFFLINE_RETENTION_MS,
  VJ_STAGE_IDLE_EVICTION_MS,
  type VjScreenAttachOutcome,
  VjStageService,
  type VjStageOutcome,
} from './vj-stage.service';

const ADMIN_USER_ID = randomUUID();
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A time every tempo and clip test starts from. */
const START_AT = 10_000;

interface RecordedBroadcast {
  adminUserId: string;
  frame: VjStageFrame;
}

/** The seven contract 7.7 reads, each a jest mock. */
function createReads() {
  return {
    readPackForStage: jest
      .fn<Promise<{ eventId: string | null } | null>, [string]>()
      .mockResolvedValue({ eventId: null }),
    existingClipIds: jest
      .fn<Promise<Set<string>>, [string[]]>()
      .mockImplementation((clipIds) => Promise.resolve(new Set(clipIds))),
    clipIdsInPack: jest
      .fn<Promise<Set<string>>, [string, string[]]>()
      .mockImplementation((_packId, clipIds) =>
        Promise.resolve(new Set(clipIds)),
      ),
    readPackClipForAdvance: jest
      .fn<Promise<{ isFavorite: boolean } | null>, [string, string]>()
      .mockResolvedValue({ isFavorite: false }),
    readSceneLook: jest.fn().mockResolvedValue(null),
    readSetlist: jest
      .fn<Promise<VjSetlistRead | null>, [string, VjSetlistReadPosition]>()
      .mockResolvedValue(null),
    readSetlistFollow: jest
      .fn<Promise<VjSetlistFollowRead | null>, [string]>()
      .mockResolvedValue(null),
  };
}

function createService() {
  const reads = createReads();
  const service = new VjStageService(reads as unknown as VjStageReadsService);
  const broadcasts: RecordedBroadcast[] = [];
  service.bindBroadcaster({
    broadcastState: (adminUserId, frame) => {
      broadcasts.push({ adminUserId, frame });
    },
  });
  return { service, broadcasts, reads };
}

/** Lookup answers with the given parts filled. */
function lookupResults(parts: Partial<VjLookupResults> = {}): VjLookupResults {
  return { ...EMPTY_VJ_LOOKUP_RESULTS, ...parts };
}

/** Answers where the listed clips exist. */
function clipsExist(...clipIds: string[]): VjLookupResults {
  return lookupResults({ existingClipIds: new Set(clipIds) });
}

/** Answers where the pack exists with the event it links. */
function packExists(
  packId: string,
  eventId: string | null = null,
): VjLookupResults {
  return lookupResults({ packs: new Map([[packId, { eventId }]]) });
}

/** A library change with every id empty but the given ones. */
function libraryChange(
  parts: Partial<VjLibraryChange> & Pick<VjLibraryChange, 'kind'>,
): VjLibraryChange {
  return {
    packId: null,
    clipId: null,
    packIds: [],
    sceneId: null,
    setlistId: null,
    setlistIds: [],
    eventId: null,
    ...parts,
  };
}

function stateOf(
  service: VjStageService,
  adminUserId = ADMIN_USER_ID,
): VjStageState {
  const state = service.getState(adminUserId);
  if (state === null) {
    throw new Error('expected a stage in memory');
  }
  return state;
}

function failureOf(
  outcome: VjStageOutcome | VjScreenAttachOutcome,
): VjAckFailure {
  if (outcome.ok) {
    throw new Error('expected a refusal');
  }
  return outcome.failure;
}

function appliedOf(outcome: VjStageOutcome) {
  if (!outcome.ok) {
    throw new Error(`expected success, got ${outcome.failure.code}`);
  }
  return outcome;
}

function frameOf(outcome: VjStageOutcome): VjStageFrame {
  const frame = appliedOf(outcome).frame;
  if (frame === null) {
    throw new Error('expected a frame');
  }
  return frame;
}

function attachedOf(outcome: VjScreenAttachOutcome) {
  if (!outcome.ok) {
    throw new Error(`expected an attach, got ${outcome.failure.code}`);
  }
  return outcome;
}

function attachScreen(
  service: VjStageService,
  socketId: string,
  screenId: unknown,
  now: number,
  options: {
    adminUserId?: string;
    restoreState?: unknown;
    restoreReads?: VjLookupResults | null;
  } = {},
): VjScreenAttachOutcome {
  return service.attachScreen(
    {
      adminUserId: options.adminUserId ?? ADMIN_USER_ID,
      socketId,
      screenId,
      restoreState: options.restoreState ?? null,
      restoreReads: options.restoreReads ?? null,
    },
    now,
  );
}

/** A remote page: one client id, a sequence that grows by one per command. */
function createRemote(service: VjStageService, adminUserId = ADMIN_USER_ID) {
  const clientId = randomUUID();
  let commandSequence = 0;
  /** The next payload of this remote, its sequence taken. */
  const nextPayload = (
    fields: Record<string, unknown>,
  ): Record<string, unknown> => {
    commandSequence += 1;
    return { ...fields, clientId, commandSequence };
  };
  return {
    clientId,
    nextPayload,
    send(
      name: VjRemoteCommandName,
      fields: Record<string, unknown>,
      now = START_AT,
      lookups: VjLookupResults = EMPTY_VJ_LOOKUP_RESULTS,
    ): VjStageOutcome {
      return service.applyRemoteCommand(
        adminUserId,
        name,
        nextPayload(fields),
        lookups,
        now,
      );
    },
  };
}

type VjTestRemote = ReturnType<typeof createRemote>;

/** 120 BPM (a 500 ms beat) with its "1" at `now`, quantized to the beat. */
function setBeatTempo(remote: VjTestRemote, now = START_AT): void {
  appliedOf(
    remote.send(
      'stage:setTempo',
      { bpm: 120, downbeatAt: now, quantize: 'beat' },
      now,
    ),
  );
}

/** A clip tap on a known clip. */
function tapClip(
  remote: VjTestRemote,
  clipId: string,
  now: number,
): VjStageOutcome {
  return remote.send('stage:goClip', { clipId }, now, clipsExist(clipId));
}

/** A status payload with the given extra fields. */
function statusPayload(
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    isFullscreen: false,
    preload: { packId: null, clips: [] },
    ...fields,
  };
}

/** The item at an index, throwing when the list is shorter. */
function itemAt<Item>(list: readonly Item[], index: number): Item {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${index}`);
  }
  return item;
}

function clipStatus(
  overrides: Partial<VjScreenClipStatus> = {},
): VjScreenClipStatus {
  return {
    clipId: randomUUID(),
    state: 'loading',
    progress: 0.5,
    failure: null,
    ...overrides,
  };
}

/** Seconds each test sequence step plays, and the same in ms. */
const STEP_SECONDS = 2;
const STEP_MS = STEP_SECONDS * 1000;
/** How early the step timer fires before a step ends. */
const EARLY_MS = VJ_LIMITS.quantizedAdvanceEarlyMs;

/** A look whose dip to white flashes, so its step needs the flash consent. */
const FLASHING_LOOK: VjSceneLook = (() => {
  const look = vjSceneLookOf(createVjStageState(randomUUID(), 0));
  return { ...look, transition: { ...look.transition, mode: 'dipWhite' } };
})();

/** A sequence as the test database holds it; a test may change its item ids
 *  between reads. A flashing step is a scene step, every other a clip step. */
interface TestSetlist {
  setlistId: string;
  itemIds: string[];
  clipIdByItemId: Map<string, string>;
  flashingItemIds: Set<string>;
  sceneId: string;
  isLooping: boolean;
}

function testSetlist(
  stepCount: number,
  options: { isLooping?: boolean; flashingIndexes?: number[] } = {},
): TestSetlist {
  const itemIds = Array.from({ length: stepCount }, () => randomUUID());
  const flashingItemIds = new Set(
    (options.flashingIndexes ?? []).map((index) => itemAt(itemIds, index)),
  );
  return {
    setlistId: randomUUID(),
    itemIds,
    clipIdByItemId: new Map(
      itemIds
        .filter((itemId) => !flashingItemIds.has(itemId))
        .map((itemId) => [itemId, randomUUID()]),
    ),
    flashingItemIds,
    sceneId: randomUUID(),
    isLooping: options.isLooping ?? false,
  };
}

/** The clip a clip step of the sequence plays, by its original index. */
function clipOfStep(setlist: TestSetlist, index: number): string {
  const clipId = setlist.clipIdByItemId.get(itemAt(setlist.itemIds, index));
  if (clipId === undefined) {
    throw new Error(`expected a clip step at index ${index}`);
  }
  return clipId;
}

/** The step index a read position lands on, as VJ_STAGE_SETLIST_READ_SQL
 *  picks it; null for none. */
function positionIndexOf(
  setlist: TestSetlist,
  position: VjSetlistReadPosition,
): number | null {
  const count = setlist.itemIds.length;
  if (position.kind === 'count') {
    return null;
  }
  if (position.kind === 'last') {
    return count > 0 ? count - 1 : null;
  }
  if (position.index < count) {
    return position.index;
  }
  return position.wrapsToFirst && count > 0 ? 0 : null;
}

/** The read the stage reads service answers for the sequence at a position. */
function setlistReadAt(
  setlist: TestSetlist,
  position: VjSetlistReadPosition,
): VjSetlistRead {
  const index = positionIndexOf(setlist, position);
  const duration = { kind: 'seconds' as const, value: STEP_SECONDS };
  let step: VjSetlistStepRead | null = null;
  if (index !== null) {
    const itemId = itemAt(setlist.itemIds, index);
    step = setlist.flashingItemIds.has(itemId)
      ? {
          kind: 'scene',
          itemId,
          index,
          sceneId: setlist.sceneId,
          look: FLASHING_LOOK,
          duration,
        }
      : {
          kind: 'clip',
          itemId,
          index,
          clipId: clipOfStep(setlist, index),
          duration,
        };
  }
  return {
    setlistId: setlist.setlistId,
    isLooping: setlist.isLooping,
    stepDuration: duration,
    itemIds: [...setlist.itemIds],
    step,
  };
}

/** The lookup answers of one read of the sequence at a position. */
function setlistAnswers(
  setlist: TestSetlist,
  position: VjSetlistReadPosition,
): VjLookupResults {
  return lookupResults({
    setlistItems: new Map([
      [
        vjSetlistItemKey(setlist.setlistId, position),
        setlistReadAt(setlist, position),
      ],
    ]),
  });
}

/** Points the reads mock at the sequence, read afresh on every call. */
function serveSetlist(
  reads: ReturnType<typeof createReads>,
  setlist: TestSetlist,
): void {
  reads.readSetlist.mockImplementation((setlistId, position) =>
    Promise.resolve(
      setlistId.toLowerCase() === setlist.setlistId
        ? setlistReadAt(setlist, position)
        : null,
    ),
  );
}

/** The follow read of the sequence as it is now. */
function followReadOf(setlist: TestSetlist): VjSetlistFollowRead {
  return { itemIds: [...setlist.itemIds], isLooping: setlist.isLooping };
}

/** Plays the sequence from a step through `stage:setlistSelect`. */
function playSetlist(
  remote: VjTestRemote,
  setlist: TestSetlist,
  index = 0,
  fields: Record<string, unknown> = {},
): VjStageFrame {
  return frameOf(
    remote.send(
      'stage:setlistSelect',
      { setlistId: setlist.setlistId, index, isPlaying: true, ...fields },
      Date.now(),
      setlistAnswers(setlist, vjSetlistSelectReadPosition(index, true)),
    ),
  );
}

/** Shows one step of the sequence by hand through `stage:setlistSelect`. */
function showSetlistStep(
  remote: VjTestRemote,
  setlist: TestSetlist,
  index: number,
  now = START_AT,
): VjStageFrame {
  return frameOf(
    remote.send(
      'stage:setlistSelect',
      { setlistId: setlist.setlistId, index },
      now,
      setlistAnswers(setlist, vjSetlistSelectReadPosition(index, false)),
    ),
  );
}

/** The broadcast frames the step timer landed. */
function setlistFramesOf(
  broadcasts: readonly RecordedBroadcast[],
): VjStageFrame[] {
  return broadcasts
    .map((broadcast) => broadcast.frame)
    .filter((frame) => frame.cause === 'setlist');
}

/** A set list change of the given kind naming the sequence. */
function setlistChange(
  kind: VjLibraryChange['kind'],
  setlist: TestSetlist,
  parts: Partial<VjLibraryChange> = {},
): VjLibraryChange {
  return libraryChange({
    kind,
    setlistId: setlist.setlistId,
    setlistIds: [setlist.setlistId],
    ...parts,
  });
}

describe('VjStageService', () => {
  let service: VjStageService;
  let broadcasts: RecordedBroadcast[];
  let reads: ReturnType<typeof createReads>;

  beforeEach(() => {
    ({ service, broadcasts, reads } = createService());
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  describe('attach and lead', () => {
    it('creates a stage at revision 0 and leads with the first screen', () => {
      const first = attachedOf(
        attachScreen(service, 'socket-a', randomUUID(), 1),
      );
      expect(first.isLead).toBe(true);
      expect(first.isRestored).toBe(false);
      expect(first.replacedSocketId).toBeNull();
      expect(first.leadChange).toBeNull();
      expect(first.applyAt).toBeNull();
      expect(first.state.revision).toBe(0);
      expect(first.state.stageEpoch).toMatch(UUID_SHAPE);

      const second = attachedOf(
        attachScreen(service, 'socket-b', randomUUID(), 2),
      );
      expect(second.isLead).toBe(false);
      expect(second.leadChange).toBeNull();

      const screens = service.listScreens(ADMIN_USER_ID, 3);
      expect(screens.map((screen) => screen.isLead)).toEqual([true, false]);
      expect(screens[0]).toMatchObject({
        isConnected: true,
        isFullscreen: false,
        connectedAt: 1,
        lastSeenAt: 1,
        preload: { packId: null, clips: [] },
        health: null,
        nextClipId: null,
        mic: null,
      });
      expect(service.leadSocketIdOf(ADMIN_USER_ID)).toBe('socket-a');
    });

    it('answers the screen number on attach', () => {
      const screenA = randomUUID();
      expect(
        attachedOf(attachScreen(service, 'socket-a', screenA, 1)).screenNumber,
      ).toBe(1);
      expect(
        attachedOf(attachScreen(service, 'socket-b', randomUUID(), 2))
          .screenNumber,
      ).toBe(2);
      service.detachSocket(ADMIN_USER_ID, 'socket-a', 3);
      expect(
        attachedOf(attachScreen(service, 'socket-a2', screenA, 4)).screenNumber,
      ).toBe(1);
      expect(
        attachedOf(attachScreen(service, 'socket-c', randomUUID(), 5))
          .screenNumber,
      ).toBe(3);
    });

    it('answers vj_screen_id_invalid for a screen id that is no uuid', () => {
      for (const screenId of ['screen-1', 42, null, undefined]) {
        const failure = failureOf(
          attachScreen(service, 'socket-a', screenId, 1),
        );
        expect(failure.code).toBe('vj_screen_id_invalid');
        expect(failure.state).toBeUndefined();
      }
      expect(service.getState(ADMIN_USER_ID)).toBeNull();
    });

    it('promotes the longest-connected screen when the lead drops', () => {
      attachScreen(service, 'socket-a', randomUUID(), 1);
      attachScreen(service, 'socket-b', randomUUID(), 2);
      attachScreen(service, 'socket-c', randomUUID(), 3);

      expect(service.detachSocket(ADMIN_USER_ID, 'socket-a', 4)).toEqual({
        leadChange: { promotedSocketId: 'socket-b' },
        hasScreenListChanged: true,
      });
      expect(service.detachSocket(ADMIN_USER_ID, 'socket-c', 5)).toEqual({
        leadChange: null,
        hasScreenListChanged: true,
      });
      expect(service.detachSocket(ADMIN_USER_ID, 'socket-b', 6)).toEqual({
        leadChange: { promotedSocketId: null },
        hasScreenListChanged: true,
      });
      expect(service.leadSocketIdOf(ADMIN_USER_ID)).toBeNull();
    });

    it('keeps the new socket connected when the replaced one disconnects late', () => {
      const screenA = randomUUID();
      attachScreen(service, 'socket-1', screenA, 1);
      const replacing = attachedOf(
        attachScreen(service, 'socket-2', screenA, 2),
      );
      expect(replacing.replacedSocketId).toBe('socket-1');
      expect(replacing.isLead).toBe(true);
      expect(service.detachSocket(ADMIN_USER_ID, 'socket-1', 3)).toEqual({
        leadChange: null,
        hasScreenListChanged: false,
      });
      expect(service.leadSocketIdOf(ADMIN_USER_ID)).toBe('socket-2');
    });

    it('promotes the longest-connected screen when the lead is replaced', () => {
      const screenA = randomUUID();
      attachScreen(service, 'socket-a', screenA, 1);
      attachScreen(service, 'socket-b', randomUUID(), 2);
      const replacing = attachedOf(
        attachScreen(service, 'socket-a2', screenA, 3),
      );
      expect(replacing.replacedSocketId).toBe('socket-a');
      expect(replacing.isLead).toBe(false);
      expect(replacing.leadChange).toEqual({ promotedSocketId: 'socket-b' });
    });

    it('carries the pending applyAt on a remote attach', () => {
      service.attachRemote(ADMIN_USER_ID, 'remote-socket', START_AT);
      const remote = createRemote(service);
      setBeatTempo(remote);
      const tap = appliedOf(tapClip(remote, randomUUID(), START_AT + 100));
      expect(tap.success.applyAt).toBe(START_AT + 500);

      expect(
        service.attachRemote(ADMIN_USER_ID, 'remote-late', START_AT + 200)
          .applyAt,
      ).toBe(START_AT + 500);
      expect(
        attachedOf(
          attachScreen(service, 'socket-a', randomUUID(), START_AT + 300),
        ).applyAt,
      ).toBe(START_AT + 500);
      expect(
        service.attachRemote(ADMIN_USER_ID, 'remote-after', START_AT + 600)
          .applyAt,
      ).toBeNull();
    });
  });

  describe('restore', () => {
    it('adopts a v1-shaped restore at revision 0', () => {
      const packId = randomUUID();
      const clipId = randomUUID();
      const restoreState = {
        stageEpoch: randomUUID(),
        revision: 14,
        activePackId: packId.toUpperCase(),
        liveClipId: clipId,
        transition: { mode: 'cut', fadeMs: 300 },
        overlay: { text: 'Hello', style: 'big', isVisible: false },
        effects: {
          speed: 2,
          isMonochrome: true,
          isMirrored: false,
          isHueCycling: false,
          isStrobing: true,
          isBlackout: false,
          strobeStartedAt: 5,
        },
        shuffle: {
          isOn: true,
          intervalKind: 'beats',
          intervalValue: 16,
          bpm: 128,
        },
      };
      expect(service.shouldAdoptRestore(ADMIN_USER_ID)).toBe(true);
      expect(service.restoreLookupsOf(restoreState, 50)).toEqual(
        expect.arrayContaining([
          { kind: 'pack', packId },
          { kind: 'clip', clipId },
        ]),
      );

      const restored = attachedOf(
        attachScreen(service, 'socket-a', randomUUID(), 50, {
          restoreState,
          restoreReads: lookupResults({
            packs: new Map([[packId, { eventId: null }]]),
            existingClipIds: new Set([clipId]),
          }),
        }),
      );
      expect(restored.isRestored).toBe(true);
      expect(restored.applyAt).toBeNull();
      expect(restored.state).toMatchObject({
        revision: 1,
        clipSequence: 1,
        activePackId: packId,
        liveClipId: clipId,
        liveSince: 50,
        transition: { mode: 'cut', length: { unit: 'ms', value: 300 } },
        tempo: { bpm: 128 },
        recentClipIds: [clipId],
        screenOverrides: {},
      });
      expect(restored.state.effects.settings.monochrome?.isOn).toBe(true);
      expect(restored.state.effects.isStrobing).toBe(false);
      expect(service.shouldAdoptRestore(ADMIN_USER_ID)).toBe(false);

      const later = attachedOf(
        attachScreen(service, 'socket-b', randomUUID(), 60, {
          restoreState: { ...restoreState, liveClipId: null },
          restoreReads: EMPTY_VJ_LOOKUP_RESULTS,
        }),
      );
      expect(later.isRestored).toBe(false);
      expect(stateOf(service).liveClipId).toBe(clipId);
    });

    it('adopts nothing when the gateway read no restore lookups', () => {
      const restored = attachedOf(
        attachScreen(service, 'socket-a', randomUUID(), 50, {
          restoreState: { activePackId: randomUUID() },
          restoreReads: null,
        }),
      );
      expect(restored.isRestored).toBe(false);
      expect(restored.state.revision).toBe(0);
    });
  });

  describe('remote commands', () => {
    beforeEach(() => {
      service.attachRemote(ADMIN_USER_ID, 'remote-socket', 0);
    });

    it('answers vj_client_id_invalid for a missing or malformed pair', () => {
      const clientId = randomUUID();
      const badPairs: Record<string, unknown>[] = [
        { clientId: 'x', commandSequence: 1 },
        { clientId, commandSequence: 0 },
        { clientId, commandSequence: 1.5 },
        { clientId, commandSequence: '1' },
        { clientId },
        { commandSequence: 1 },
      ];
      for (const pair of badPairs) {
        const payload = { mode: 'cut', ...pair };
        expect(
          service.prepareRemoteCommand(
            ADMIN_USER_ID,
            'stage:setTransition',
            payload,
            START_AT,
          ).failure?.code,
        ).toBe('vj_client_id_invalid');
        expect(
          failureOf(
            service.applyRemoteCommand(
              ADMIN_USER_ID,
              'stage:setTransition',
              payload,
              EMPTY_VJ_LOOKUP_RESULTS,
              START_AT,
            ),
          ).code,
        ).toBe('vj_client_id_invalid');
      }
      expect(stateOf(service).revision).toBe(0);
    });

    it('answers vj_stale_command for a sequence at or below the last', () => {
      const clientId = randomUUID();
      const apply = (
        commandSequence: number,
        fields: Record<string, unknown>,
      ) =>
        service.applyRemoteCommand(
          ADMIN_USER_ID,
          'stage:setTransition',
          { ...fields, clientId, commandSequence },
          EMPTY_VJ_LOOKUP_RESULTS,
          START_AT,
        );
      expect(appliedOf(apply(2, { mode: 'cut' })).success.revision).toBe(1);
      for (const commandSequence of [2, 1]) {
        const failure = failureOf(apply(commandSequence, { mode: 'fade' }));
        expect(failure.code).toBe('vj_stale_command');
        expect(failure.state?.revision).toBe(1);
      }
      expect(stateOf(service).transition.mode).toBe('cut');
    });

    it('records the sequence of a refused command', () => {
      const clientId = randomUUID();
      const payload = { speed: 3, clientId, commandSequence: 1 };
      expect(
        failureOf(
          service.applyRemoteCommand(
            ADMIN_USER_ID,
            'stage:setEffects',
            payload,
            EMPTY_VJ_LOOKUP_RESULTS,
            START_AT,
          ),
        ).code,
      ).toBe('vj_speed_invalid');
      expect(
        service.prepareRemoteCommand(
          ADMIN_USER_ID,
          'stage:setEffects',
          { speed: 2, clientId, commandSequence: 1 },
          START_AT,
        ).failure?.code,
      ).toBe('vj_stale_command');
      expect(stateOf(service).revision).toBe(0);
    });

    it('records nothing while preparing a command', () => {
      const clipId = randomUUID();
      const payload = {
        clipId,
        clientId: randomUUID(),
        commandSequence: 1,
      };
      expect(
        service.prepareRemoteCommand(
          ADMIN_USER_ID,
          'stage:goClip',
          payload,
          START_AT,
        ),
      ).toEqual({ failure: null, lookups: [{ kind: 'clip', clipId }] });
      expect(
        appliedOf(
          service.applyRemoteCommand(
            ADMIN_USER_ID,
            'stage:goClip',
            payload,
            clipsExist(clipId),
            START_AT,
          ),
        ).success,
      ).toEqual({ revision: 1, isNoop: false, applyAt: null });
    });

    it('forgets the least recently used client after 32', () => {
      const remotes = Array.from(
        { length: VJ_CLIENT_SEQUENCE_MEMORY + 1 },
        () => createRemote(service),
      );
      for (const remote of remotes) {
        expect(remote.send('stage:setTransition', { mode: 'cut' }).ok).toBe(
          true,
        );
      }
      expect(
        service.prepareRemoteCommand(
          ADMIN_USER_ID,
          'stage:setTransition',
          {
            mode: 'fade',
            clientId: itemAt(remotes, 1).clientId,
            commandSequence: 1,
          },
          START_AT,
        ).failure?.code,
      ).toBe('vj_stale_command');
      expect(
        service.applyRemoteCommand(
          ADMIN_USER_ID,
          'stage:setTransition',
          {
            mode: 'fade',
            clientId: itemAt(remotes, 0).clientId,
            commandSequence: 1,
          },
          EMPTY_VJ_LOOKUP_RESULTS,
          START_AT,
        ).ok,
      ).toBe(true);
    });

    it('applies a change, bumps the revision and names the source client', () => {
      const remote = createRemote(service);
      const frame = frameOf(
        remote.send('stage:setTransition', { mode: 'cut' }, 5000),
      );
      expect(frame).toEqual({
        state: expect.objectContaining({
          revision: 1,
          updatedAt: 5000,
          transition: { mode: 'cut', length: { unit: 'ms', value: 800 } },
        }) as VjStageState,
        cause: 'command',
        sourceClientId: remote.clientId,
        applyAt: null,
      });
    });

    it('stamps applyAt for a clip tap under quantize and null for a pad', () => {
      const remote = createRemote(service);
      setBeatTempo(remote);
      const clipId = randomUUID();
      const tap = frameOf(tapClip(remote, clipId, START_AT + 100));
      expect(tap.applyAt).toBe(START_AT + 500);
      expect(tap.state.liveSince).toBe(START_AT + 500);
      expect(tap.state.recentClipIds).toEqual([clipId]);

      const pad = appliedOf(
        remote.send('stage:setEffects', { speed: 2 }, START_AT + 600),
      );
      expect(pad.success.applyAt).toBeNull();
      expect(pad.frame?.applyAt).toBeNull();
    });

    it('keeps applyAt monotonic and flushes with blackout isImmediate', () => {
      const remote = createRemote(service);
      setBeatTempo(remote);
      expect(
        appliedOf(tapClip(remote, randomUUID(), START_AT + 100)).success
          .applyAt,
      ).toBe(START_AT + 500);
      expect(
        appliedOf(remote.send('stage:setEffects', { speed: 2 }, START_AT + 200))
          .success.applyAt,
      ).toBe(START_AT + 500);
      expect(
        appliedOf(tapClip(remote, randomUUID(), START_AT + 400)).success
          .applyAt,
      ).toBe(START_AT + 1000);
      const blackout = frameOf(
        remote.send(
          'stage:setEffects',
          { isBlackout: true, isImmediate: true },
          START_AT + 450,
        ),
      );
      expect(blackout.applyAt).toBeNull();
      expect(blackout.state.effects.isBlackout).toBe(true);
      expect(
        appliedOf(remote.send('stage:setEffects', { speed: 4 }, START_AT + 460))
          .success.applyAt,
      ).toBeNull();
    });

    it('answers a noop with applyAt null and leaves the pending time alone', () => {
      const remote = createRemote(service);
      setBeatTempo(remote);
      appliedOf(tapClip(remote, randomUUID(), START_AT + 100));
      const revision = stateOf(service).revision;
      expect(
        remote.send('stage:setEffects', { speed: 1 }, START_AT + 200),
      ).toEqual({
        ok: true,
        success: { revision, isNoop: true, applyAt: null },
        frame: null,
      });
      expect(
        appliedOf(remote.send('stage:setEffects', { speed: 2 }, START_AT + 300))
          .success.applyAt,
      ).toBe(START_AT + 500);
    });

    it('reruns the rules at apply and answers vj_clip_not_found from the lookups', async () => {
      const remote = createRemote(service);
      const clipId = randomUUID();
      expect(
        failureOf(
          remote.send(
            'stage:goClip',
            { clipId },
            START_AT,
            EMPTY_VJ_LOOKUP_RESULTS,
          ),
        ).code,
      ).toBe('vj_clip_not_found');

      reads.existingClipIds.mockResolvedValueOnce(new Set());
      const unknown = await service.runRemoteCommand(
        ADMIN_USER_ID,
        'stage:goClip',
        remote.nextPayload({ clipId }),
        () => START_AT,
      );
      expect(failureOf(unknown).code).toBe('vj_clip_not_found');
      expect(reads.existingClipIds).toHaveBeenLastCalledWith([clipId]);

      const known = await service.runRemoteCommand(
        ADMIN_USER_ID,
        'stage:goClip',
        remote.nextPayload({ clipId }),
        () => START_AT,
      );
      expect(appliedOf(known).frame?.state.liveClipId).toBe(clipId);
      expect(stateOf(service).revision).toBe(1);
    });

    it('reads the lookups again when a pack change lands before the apply', async () => {
      const shuffler = createRemote(service);
      const packer = createRemote(service);
      const firstPackId = randomUUID();
      const secondPackId = randomUUID();
      const clipId = randomUUID();
      appliedOf(
        packer.send(
          'stage:setPack',
          { packId: firstPackId },
          START_AT,
          packExists(firstPackId),
        ),
      );
      reads.clipIdsInPack
        .mockImplementationOnce(() => {
          appliedOf(
            packer.send(
              'stage:setPack',
              { packId: secondPackId },
              START_AT,
              packExists(secondPackId),
            ),
          );
          return Promise.resolve(new Set([clipId]));
        })
        .mockResolvedValueOnce(new Set());

      const outcome = await service.runRemoteCommand(
        ADMIN_USER_ID,
        'stage:setShuffle',
        shuffler.nextPayload({ excludedClipIds: [clipId] }),
        () => START_AT,
      );
      expect(failureOf(outcome).code).toBe('vj_clip_not_in_pack');
      expect(reads.clipIdsInPack.mock.calls).toEqual([
        [firstPackId, [clipId]],
        [secondPackId, [clipId]],
      ]);
      expect(stateOf(service).shuffle.excludedClipIds).toEqual([]);
    });

    it('acks vj_server_error for a failed read and records the sequence', async () => {
      const remote = createRemote(service);
      const clipId = randomUUID();
      const payload = remote.nextPayload({ clipId });
      reads.existingClipIds.mockRejectedValueOnce(new Error('read failed'));
      expect(
        failureOf(
          await service.runRemoteCommand(
            ADMIN_USER_ID,
            'stage:goClip',
            payload,
            () => START_AT,
          ),
        ).code,
      ).toBe('vj_server_error');
      expect(
        failureOf(
          service.applyRemoteCommand(
            ADMIN_USER_ID,
            'stage:goClip',
            payload,
            clipsExist(clipId),
            START_AT,
          ),
        ).code,
      ).toBe('vj_stale_command');
      expect(
        appliedOf(
          remote.send('stage:goClip', { clipId }, START_AT, clipsExist(clipId)),
        ).success.revision,
      ).toBe(1);
    });

    it('answers vj_stale_command with the state and records the sequence when the lookups move on both reads', async () => {
      const shuffler = createRemote(service);
      const packer = createRemote(service);
      const packIds = [randomUUID(), randomUUID(), randomUUID()];
      const clipId = randomUUID();
      const switchPack = (packId: string): void => {
        appliedOf(
          packer.send(
            'stage:setPack',
            { packId },
            START_AT,
            packExists(packId),
          ),
        );
      };
      switchPack(itemAt(packIds, 0));
      reads.clipIdsInPack
        .mockImplementationOnce(() => {
          switchPack(itemAt(packIds, 1));
          return Promise.resolve(new Set([clipId]));
        })
        .mockImplementationOnce(() => {
          switchPack(itemAt(packIds, 2));
          return Promise.resolve(new Set([clipId]));
        });
      const payload = shuffler.nextPayload({ excludedClipIds: [clipId] });

      const failure = failureOf(
        await service.runRemoteCommand(
          ADMIN_USER_ID,
          'stage:setShuffle',
          payload,
          () => START_AT,
        ),
      );
      expect(failure.code).toBe('vj_stale_command');
      expect(failure.state?.activePackId).toBe(itemAt(packIds, 2));
      expect(reads.clipIdsInPack).toHaveBeenCalledTimes(2);
      expect(stateOf(service).shuffle.excludedClipIds).toEqual([]);
      expect(
        failureOf(
          service.applyRemoteCommand(
            ADMIN_USER_ID,
            'stage:setShuffle',
            payload,
            lookupResults({ clipIdsInPack: new Set([clipId]) }),
            START_AT,
          ),
        ).code,
      ).toBe('vj_stale_command');
    });

    it('answers vj_stale_setlist when the set list moved between prepare and apply', () => {
      const first = createRemote(service);
      const second = createRemote(service);
      const setlist = testSetlist(3);
      appliedOf(
        first.send(
          'stage:setlistSelect',
          { setlistId: setlist.setlistId, index: null },
          START_AT,
          setlistAnswers(setlist, { kind: 'count' }),
        ),
      );
      const stepPayload = first.nextPayload({});
      const prepared = service.prepareRemoteCommand(
        ADMIN_USER_ID,
        'stage:setlistNext',
        stepPayload,
        START_AT,
      );
      const firstStep: VjSetlistReadPosition = {
        kind: 'index',
        index: 0,
        wrapsToFirst: false,
      };
      expect(prepared.lookups).toEqual([
        {
          kind: 'setlistItem',
          setlistId: setlist.setlistId,
          position: firstStep,
        },
      ]);
      const firstItem = setlistAnswers(setlist, firstStep);
      appliedOf(second.send('stage:setlistNext', {}, START_AT, firstItem));
      expect(stateOf(service).setlistIndex).toBe(0);

      const stale = failureOf(
        service.applyRemoteCommand(
          ADMIN_USER_ID,
          'stage:setlistNext',
          stepPayload,
          firstItem,
          START_AT,
        ),
      );
      expect(stale.code).toBe('vj_stale_setlist');
      expect(stale.state?.setlistIndex).toBe(0);
      expect(stateOf(service).setlistIndex).toBe(0);
    });

    it('records the sequence of a command whose write failed and answers its code', () => {
      const remote = createRemote(service);
      const payload = remote.nextPayload({ isLooping: true });
      expect(
        failureOf(
          service.refuseRemoteWrite(
            ADMIN_USER_ID,
            payload,
            'vj_setlist_not_found',
          ),
        ).code,
      ).toBe('vj_setlist_not_found');
      expect(
        failureOf(
          service.refuseRemoteWrite(ADMIN_USER_ID, payload, 'vj_server_error'),
        ).code,
      ).toBe('vj_stale_command');
      expect(
        failureOf(
          service.refuseRemoteWrite(randomUUID(), payload, 'vj_server_error'),
        ).code,
      ).toBe('vj_not_attached');
    });

    it('lands Loop on the active sequence with the clock kept', () => {
      const remote = createRemote(service);
      const setlist = testSetlist(2);
      const shown = showSetlistStep(remote, setlist, 1);
      expect(shown.state.setlistPlayback.isLooping).toBe(false);
      const looped = frameOf(
        remote.send('stage:setlistSetLooping', { isLooping: true }, START_AT),
      );
      expect(looped.cause).toBe('command');
      expect(looped.state.setlistIndex).toBe(1);
      expect(looped.state.setlistPlayback).toMatchObject({
        isLooping: true,
        status: 'manual',
      });
    });
  });

  describe('advance', () => {
    it('lands an advance like a clip tap with cause shuffle', async () => {
      attachScreen(service, 'socket-lead', randomUUID(), 0);
      attachScreen(service, 'socket-follow', randomUUID(), 1);
      service.attachRemote(ADMIN_USER_ID, 'remote-socket', 0);
      const remote = createRemote(service);
      const packId = randomUUID();
      appliedOf(
        remote.send('stage:setPack', { packId }, START_AT, packExists(packId)),
      );
      appliedOf(remote.send('stage:setShuffle', { isOn: true }, START_AT));
      const clipId = randomUUID();
      const advance = {
        expectedClipSequence: stateOf(service).clipSequence,
        clipId,
      };
      expect(
        service.prepareScreenAdvance(ADMIN_USER_ID, 'socket-follow', advance)
          .failure?.code,
      ).toBe('vj_not_lead');
      expect(
        service.prepareScreenAdvance(ADMIN_USER_ID, 'socket-lead', advance)
          .lookups,
      ).toEqual([{ kind: 'packClip', packId, clipId }]);
      const outcome = await service.runScreenAdvance(
        ADMIN_USER_ID,
        'socket-lead',
        advance,
        () => START_AT,
      );
      const frame = frameOf(outcome);
      expect(frame.cause).toBe('shuffle');
      expect(frame.sourceClientId).toBeNull();
      expect(frame.state.liveClipId).toBe(clipId);
      expect(reads.readPackClipForAdvance).toHaveBeenCalledWith(packId, clipId);
      expect(
        failureOf(
          service.applyScreenAdvance(
            ADMIN_USER_ID,
            'socket-lead',
            {
              expectedClipSequence: frame.state.clipSequence,
              clipId: randomUUID(),
            },
            lookupResults({
              packClips: new Map([[vjPackClipKey(packId, clipId), null]]),
            }),
            START_AT,
          ),
        ).code,
      ).toBe('vj_clip_not_in_pack');
    });
  });

  describe('timers', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(START_AT);
      service.attachRemote(ADMIN_USER_ID, 'remote-socket', START_AT);
    });

    it('lands a strobe timeout at once and flushes the pending applyAt', () => {
      const remote = createRemote(service);
      setBeatTempo(remote);
      const strobe = frameOf(
        remote.send('stage:setStrobe', { isStrobing: true }, Date.now()),
      );
      expect(strobe.applyAt).toBeNull();
      expect(strobe.state.effects.strobeStartedAt).toBe(START_AT);

      jest.advanceTimersByTime(9_900);
      const pendingClipId = randomUUID();
      const tap = appliedOf(tapClip(remote, pendingClipId, Date.now()));
      expect(tap.success.applyAt).toBe(START_AT + 10_500);
      expect(broadcasts).toHaveLength(0);

      jest.advanceTimersByTime(100);
      expect(broadcasts).toHaveLength(1);
      const timeout = itemAt(broadcasts, 0).frame;
      expect(timeout.cause).toBe('strobe_timeout');
      expect(timeout.applyAt).toBeNull();
      expect(timeout.state.liveClipId).toBe(pendingClipId);
      expect(timeout.state.effects).toMatchObject({
        isStrobing: false,
        strobeStartedAt: null,
      });
    });

    it('hides the overlay at hideAt with cause overlay_timeout', () => {
      const remote = createRemote(service);
      const shown = frameOf(
        remote.send(
          'stage:setOverlay',
          { text: 'Hello', isVisible: true, hideAfterMs: 5000 },
          Date.now(),
        ),
      );
      expect(shown.state.overlay.hideAt).toBe(START_AT + 5000);
      jest.advanceTimersByTime(4_999);
      expect(broadcasts).toHaveLength(0);
      jest.advanceTimersByTime(1);
      const hidden = itemAt(broadcasts, 0).frame;
      expect(hidden.cause).toBe('overlay_timeout');
      expect(hidden.state.overlay).toMatchObject({
        text: 'Hello',
        isVisible: false,
        hideAt: null,
      });
    });

    it('hides the countdown after the hold with cause countdown_end', () => {
      const remote = createRemote(service);
      appliedOf(
        remote.send(
          'stage:setCountdown',
          { isVisible: true, durationMs: 5000 },
          Date.now(),
        ),
      );
      jest.advanceTimersByTime(14_999);
      expect(broadcasts).toHaveLength(0);
      jest.advanceTimersByTime(1);
      const ended = itemAt(broadcasts, 0).frame;
      expect(ended.cause).toBe('countdown_end');
      expect(ended.state.countdown).toEqual({
        isVisible: false,
        targetAt: START_AT + 5000,
        label: '',
      });
    });

    describe('sequence step timer', () => {
      let remote: VjTestRemote;

      beforeEach(() => {
        remote = createRemote(service);
      });

      it('advances a playing sequence at each step end and finishes after the last step', async () => {
        const setlist = testSetlist(3);
        serveSetlist(reads, setlist);
        const played = playSetlist(remote, setlist);
        expect(played.state.setlistIndex).toBe(0);
        expect(played.state.liveClipId).toBe(clipOfStep(setlist, 0));
        expect(played.state.setlistPlayback).toMatchObject({
          status: 'playing',
          itemId: itemAt(setlist.itemIds, 0),
          stepStartedAt: START_AT,
          stepEndsAt: START_AT + STEP_MS,
          stepDurationMs: STEP_MS,
        });

        await jest.advanceTimersByTimeAsync(STEP_MS - EARLY_MS - 1);
        expect(reads.readSetlist).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        expect(reads.readSetlist).toHaveBeenLastCalledWith(setlist.setlistId, {
          kind: 'index',
          index: 1,
          wrapsToFirst: false,
        });
        const second = itemAt(setlistFramesOf(broadcasts), 0);
        expect(second.sourceClientId).toBeNull();
        expect(second.applyAt).toBe(START_AT + STEP_MS);
        expect(second.state.setlistIndex).toBe(1);
        expect(second.state.liveClipId).toBe(clipOfStep(setlist, 1));
        expect(second.state.setlistPlayback).toMatchObject({
          status: 'playing',
          itemId: itemAt(setlist.itemIds, 1),
          stepStartedAt: START_AT + STEP_MS,
          stepEndsAt: START_AT + 2 * STEP_MS,
        });

        await jest.advanceTimersByTimeAsync(STEP_MS);
        const third = itemAt(setlistFramesOf(broadcasts), 1);
        expect(third.state.setlistIndex).toBe(2);
        expect(third.state.setlistPlayback.stepEndsAt).toBe(
          START_AT + 3 * STEP_MS,
        );

        await jest.advanceTimersByTimeAsync(STEP_MS);
        const finished = itemAt(setlistFramesOf(broadcasts), 2);
        expect(finished.applyAt).toBe(START_AT + 3 * STEP_MS);
        expect(finished.state.setlistIndex).toBe(2);
        expect(finished.state.liveClipId).toBe(clipOfStep(setlist, 2));
        expect(finished.state.setlistPlayback).toMatchObject({
          status: 'finished',
          stepStartedAt: null,
          stepEndsAt: null,
        });
        expect(jest.getTimerCount()).toBe(0);
        await jest.advanceTimersByTimeAsync(10 * STEP_MS);
        expect(setlistFramesOf(broadcasts)).toHaveLength(3);
      });

      it('wraps a looping sequence from its last step to step 1', async () => {
        const setlist = testSetlist(2, { isLooping: true });
        serveSetlist(reads, setlist);
        const played = playSetlist(remote, setlist, 1);
        expect(played.state.setlistPlayback.isLooping).toBe(true);

        await jest.advanceTimersByTimeAsync(STEP_MS - EARLY_MS);
        expect(reads.readSetlist).toHaveBeenLastCalledWith(setlist.setlistId, {
          kind: 'index',
          index: 2,
          wrapsToFirst: true,
        });
        const wrapped = itemAt(setlistFramesOf(broadcasts), 0);
        expect(wrapped.state.setlistIndex).toBe(0);
        expect(wrapped.state.liveClipId).toBe(clipOfStep(setlist, 0));
        expect(wrapped.state.setlistPlayback).toMatchObject({
          status: 'playing',
          stepEndsAt: START_AT + 2 * STEP_MS,
        });
      });

      it('lands needsFlashConsent on a flashing step no one confirmed for the run', async () => {
        const setlist = testSetlist(2, { flashingIndexes: [1] });
        serveSetlist(reads, setlist);
        playSetlist(remote, setlist);

        await jest.advanceTimersByTimeAsync(STEP_MS - EARLY_MS);
        const held = itemAt(setlistFramesOf(broadcasts), 0);
        expect(held.state.liveClipId).toBe(clipOfStep(setlist, 0));
        expect(held.state.transition.mode).not.toBe('dipWhite');
        expect(held.state.setlistPlayback).toMatchObject({
          status: 'needsFlashConsent',
          stepStartedAt: null,
          stepEndsAt: null,
        });
        expect(jest.getTimerCount()).toBe(0);
      });

      it('recalls a flashing step when the run confirmed the flash warning', async () => {
        const setlist = testSetlist(2, { flashingIndexes: [1] });
        serveSetlist(reads, setlist);
        playSetlist(remote, setlist, 0, { isFlashConfirmed: true });

        await jest.advanceTimersByTimeAsync(STEP_MS - EARLY_MS);
        const recalled = itemAt(setlistFramesOf(broadcasts), 0);
        expect(recalled.state.setlistIndex).toBe(1);
        expect(recalled.state.transition.mode).toBe('dipWhite');
        expect(recalled.state.setlistPlayback).toMatchObject({
          status: 'playing',
          isFlashConfirmed: true,
          stepEndsAt: START_AT + 2 * STEP_MS,
        });
      });

      it('retries a failed step read after setlistTimerRetryMs and holds the step meanwhile', async () => {
        const setlist = testSetlist(3);
        serveSetlist(reads, setlist);
        reads.readSetlist.mockRejectedValueOnce(new Error('read failed'));
        playSetlist(remote, setlist);

        await jest.advanceTimersByTimeAsync(STEP_MS - EARLY_MS);
        expect(reads.readSetlist).toHaveBeenCalledTimes(1);
        expect(setlistFramesOf(broadcasts)).toHaveLength(0);
        expect(stateOf(service).setlistIndex).toBe(0);

        await jest.advanceTimersByTimeAsync(VJ_LIMITS.setlistTimerRetryMs - 1);
        expect(reads.readSetlist).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(reads.readSetlist).toHaveBeenCalledTimes(2);
        const retriedAt =
          START_AT + STEP_MS - EARLY_MS + VJ_LIMITS.setlistTimerRetryMs;
        const advanced = itemAt(setlistFramesOf(broadcasts), 0);
        expect(advanced.applyAt).toBeNull();
        expect(advanced.state.setlistIndex).toBe(1);
        expect(advanced.state.setlistPlayback).toMatchObject({
          status: 'playing',
          stepStartedAt: retriedAt,
          stepEndsAt: retriedAt + STEP_MS,
        });
      });

      it('drops a failed step read when the run was paused meanwhile', async () => {
        const setlist = testSetlist(3);
        let rejectRead: (error: Error) => void = () => undefined;
        reads.readSetlist.mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectRead = reject;
            }),
        );
        playSetlist(remote, setlist);
        await jest.advanceTimersByTimeAsync(STEP_MS - EARLY_MS);
        expect(reads.readSetlist).toHaveBeenCalledTimes(1);
        appliedOf(
          remote.send(
            'stage:setlistSetPlaying',
            { isPlaying: false },
            Date.now(),
          ),
        );
        rejectRead(new Error('read failed'));
        await jest.advanceTimersByTimeAsync(0);
        expect(jest.getTimerCount()).toBe(0);
        await jest.advanceTimersByTimeAsync(10 * VJ_LIMITS.setlistTimerRetryMs);
        expect(reads.readSetlist).toHaveBeenCalledTimes(1);
        expect(stateOf(service).setlistPlayback.status).toBe('paused');
      });

      it('reads again at once when a library follow moved the index while the read was out', async () => {
        const setlist = testSetlist(3);
        const removedItemId = itemAt(setlist.itemIds, 0);
        const lastClipId = clipOfStep(setlist, 2);
        serveSetlist(reads, setlist);
        let releaseRead: (read: VjSetlistRead | null) => void = () => undefined;
        reads.readSetlist.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseRead = resolve;
            }),
        );
        playSetlist(remote, setlist, 1);
        await jest.advanceTimersByTimeAsync(STEP_MS - EARLY_MS);
        expect(reads.readSetlist).toHaveBeenCalledTimes(1);

        setlist.itemIds = setlist.itemIds.filter(
          (itemId) => itemId !== removedItemId,
        );
        const followed = service.applyLibraryChange(
          setlistChange('setlist_items_changed', setlist),
          Date.now(),
          new Map([[setlist.setlistId, followReadOf(setlist)]]),
        );
        expect(itemAt(followed, 0).frame.state.setlistIndex).toBe(0);
        expect(itemAt(followed, 0).frame.state.setlistPlayback.stepEndsAt).toBe(
          START_AT + STEP_MS,
        );

        releaseRead(
          setlistReadAt(setlist, {
            kind: 'index',
            index: 2,
            wrapsToFirst: false,
          }),
        );
        await jest.advanceTimersByTimeAsync(0);
        expect(reads.readSetlist).toHaveBeenCalledTimes(2);
        expect(reads.readSetlist).toHaveBeenLastCalledWith(setlist.setlistId, {
          kind: 'index',
          index: 1,
          wrapsToFirst: false,
        });
        const advanced = itemAt(setlistFramesOf(broadcasts), 0);
        expect(advanced.applyAt).toBe(START_AT + STEP_MS);
        expect(advanced.state.setlistIndex).toBe(1);
        expect(advanced.state.liveClipId).toBe(lastClipId);
        expect(advanced.state.setlistPlayback).toMatchObject({
          status: 'playing',
          stepEndsAt: START_AT + 2 * STEP_MS,
        });
      });

      it('lands the follow of an item edit whose follow has not landed, then plays the step after the one on screen', async () => {
        const setlist = testSetlist(4);
        const secondId = itemAt(setlist.itemIds, 1);
        const thirdId = itemAt(setlist.itemIds, 2);
        const fourthId = itemAt(setlist.itemIds, 3);
        const lastClipId = clipOfStep(setlist, 3);
        serveSetlist(reads, setlist);
        playSetlist(remote, setlist, 2);
        // The save of [B, C, D] committed; its library follow is still out.
        setlist.itemIds = [secondId, thirdId, fourthId];

        await jest.advanceTimersByTimeAsync(STEP_MS - EARLY_MS);
        await jest.advanceTimersByTimeAsync(0);

        expect(reads.readSetlist).toHaveBeenCalledTimes(2);
        expect(reads.readSetlist).toHaveBeenNthCalledWith(
          1,
          setlist.setlistId,
          { kind: 'index', index: 3, wrapsToFirst: false },
        );
        expect(reads.readSetlist).toHaveBeenLastCalledWith(setlist.setlistId, {
          kind: 'index',
          index: 2,
          wrapsToFirst: false,
        });
        const libraryFrames = broadcasts
          .map((broadcast) => broadcast.frame)
          .filter((frame) => frame.cause === 'library');
        expect(libraryFrames).toHaveLength(1);
        expect(itemAt(libraryFrames, 0).state.setlistIndex).toBe(1);
        expect(itemAt(libraryFrames, 0).state.setlistPlayback).toMatchObject({
          itemId: thirdId,
          status: 'playing',
          stepEndsAt: START_AT + STEP_MS,
        });
        const advancedFrames = setlistFramesOf(broadcasts);
        expect(advancedFrames).toHaveLength(1);
        const advanced = itemAt(advancedFrames, 0);
        expect(advanced.applyAt).toBe(START_AT + STEP_MS);
        expect(advanced.state.setlistIndex).toBe(2);
        expect(advanced.state.liveClipId).toBe(lastClipId);
        expect(advanced.state.setlistPlayback).toMatchObject({
          status: 'playing',
          itemId: fourthId,
        });
        expect(service.getSetlistItemIds(ADMIN_USER_ID)).toEqual([
          secondId,
          thirdId,
          fourthId,
        ]);

        // The follow the gateway lands later finds nothing to move.
        expect(
          service.applyLibraryChange(
            setlistChange('setlist_items_changed', setlist),
            Date.now(),
            new Map([[setlist.setlistId, followReadOf(setlist)]]),
          ),
        ).toEqual([]);
      });

      it('plays the next step at once when a clip delete empties the frame of the playing step', async () => {
        const setlist = testSetlist(3);
        const firstId = itemAt(setlist.itemIds, 0);
        const thirdId = itemAt(setlist.itemIds, 2);
        const deletedClipId = clipOfStep(setlist, 1);
        const lastClipId = clipOfStep(setlist, 2);
        serveSetlist(reads, setlist);
        playSetlist(remote, setlist, 1);
        jest.advanceTimersByTime(1000);

        setlist.itemIds = [firstId, thirdId];
        const deleted = itemAt(
          service.applyLibraryChange(
            setlistChange('clip_deleted', setlist, {
              setlistId: null,
              clipId: deletedClipId,
            }),
            Date.now(),
            new Map([[setlist.setlistId, followReadOf(setlist)]]),
          ),
          0,
        ).frame;
        expect(deleted.cause).toBe('library');
        expect(deleted.state.liveClipId).toBeNull();
        expect(deleted.state.setlistIndex).toBe(0);
        expect(deleted.state.setlistPlayback).toMatchObject({
          status: 'playing',
          itemId: null,
          stepStartedAt: START_AT + 1000 - STEP_MS,
          stepEndsAt: START_AT + 1000,
          stepDurationMs: STEP_MS,
        });

        await jest.advanceTimersByTimeAsync(0);
        expect(reads.readSetlist).toHaveBeenLastCalledWith(setlist.setlistId, {
          kind: 'index',
          index: 1,
          wrapsToFirst: false,
        });
        const advanced = itemAt(setlistFramesOf(broadcasts), 0);
        expect(advanced.state.setlistIndex).toBe(1);
        expect(advanced.state.liveClipId).toBe(lastClipId);
        expect(advanced.state.setlistPlayback.itemId).toBe(thirdId);
      });

      it('logs the owner id only and retries when the landing after the read throws', async () => {
        const errorSpy = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);
        const setlist = testSetlist(3);
        serveSetlist(reads, setlist);
        reads.readSetlist.mockResolvedValueOnce({
          ...setlistReadAt(setlist, {
            kind: 'index',
            index: 1,
            wrapsToFirst: false,
          }),
          itemIds: null,
        } as unknown as VjSetlistRead);
        playSetlist(remote, setlist);

        await jest.advanceTimersByTimeAsync(STEP_MS - EARLY_MS);
        expect(setlistFramesOf(broadcasts)).toHaveLength(0);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const logged = String(errorSpy.mock.calls[0]?.[0]);
        expect(logged).toContain(ADMIN_USER_ID);
        expect(logged).not.toContain(setlist.setlistId);

        await jest.advanceTimersByTimeAsync(VJ_LIMITS.setlistTimerRetryMs);
        expect(reads.readSetlist).toHaveBeenCalledTimes(2);
        expect(itemAt(setlistFramesOf(broadcasts), 0).state.setlistIndex).toBe(
          1,
        );
        errorSpy.mockRestore();
      });

      it('keeps the run going when the broadcast of a landed step throws', async () => {
        const errorSpy = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);
        const setlist = testSetlist(3);
        serveSetlist(reads, setlist);
        playSetlist(remote, setlist);
        service.bindBroadcaster({
          broadcastState: () => {
            throw new Error('emit failed');
          },
        });

        await jest.advanceTimersByTimeAsync(STEP_MS - EARLY_MS);
        expect(stateOf(service).setlistIndex).toBe(1);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(STEP_MS);
        expect(stateOf(service).setlistIndex).toBe(2);
        errorSpy.mockRestore();
      });

      it('reads again at once when Loop changed while the read was out', async () => {
        const setlist = testSetlist(2);
        serveSetlist(reads, setlist);
        let releaseRead: (read: VjSetlistRead | null) => void = () => undefined;
        reads.readSetlist.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseRead = resolve;
            }),
        );
        playSetlist(remote, setlist, 1);
        await jest.advanceTimersByTimeAsync(STEP_MS - EARLY_MS);
        expect(reads.readSetlist).toHaveBeenLastCalledWith(setlist.setlistId, {
          kind: 'index',
          index: 2,
          wrapsToFirst: false,
        });

        setlist.isLooping = true;
        appliedOf(
          remote.send(
            'stage:setlistSetLooping',
            { isLooping: true },
            Date.now(),
          ),
        );
        releaseRead(
          setlistReadAt(setlist, {
            kind: 'index',
            index: 2,
            wrapsToFirst: false,
          }),
        );
        await jest.advanceTimersByTimeAsync(0);

        expect(reads.readSetlist).toHaveBeenCalledTimes(2);
        expect(reads.readSetlist).toHaveBeenLastCalledWith(setlist.setlistId, {
          kind: 'index',
          index: 2,
          wrapsToFirst: true,
        });
        const wrapped = itemAt(setlistFramesOf(broadcasts), 0);
        expect(wrapped.state.setlistIndex).toBe(0);
        expect(wrapped.state.setlistPlayback.status).toBe('playing');
      });

      it('reads again at once when a step edit moved nothing while the read was out', async () => {
        const setlist = testSetlist(2);
        serveSetlist(reads, setlist);
        let releaseRead: (read: VjSetlistRead | null) => void = () => undefined;
        reads.readSetlist.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseRead = resolve;
            }),
        );
        playSetlist(remote, setlist, 1);
        await jest.advanceTimersByTimeAsync(STEP_MS - EARLY_MS);
        const endRead: VjSetlistRead = {
          ...setlistReadAt(setlist, {
            kind: 'index',
            index: 2,
            wrapsToFirst: false,
          }),
          step: null,
        };

        const appendedId = randomUUID();
        const appendedClipId = randomUUID();
        setlist.itemIds = [...setlist.itemIds, appendedId];
        setlist.clipIdByItemId.set(appendedId, appendedClipId);
        expect(
          service.applyLibraryChange(
            setlistChange('setlist_items_changed', setlist),
            Date.now(),
            new Map([[setlist.setlistId, followReadOf(setlist)]]),
          ),
        ).toEqual([]);
        releaseRead(endRead);
        await jest.advanceTimersByTimeAsync(0);

        expect(reads.readSetlist).toHaveBeenCalledTimes(2);
        const advanced = itemAt(setlistFramesOf(broadcasts), 0);
        expect(advanced.state.setlistIndex).toBe(2);
        expect(advanced.state.liveClipId).toBe(appendedClipId);
        expect(advanced.state.setlistPlayback.status).toBe('playing');
      });

      it('lands nothing from a read when a Next landed meanwhile, then runs from the new step', async () => {
        const setlist = testSetlist(3);
        serveSetlist(reads, setlist);
        let releaseRead: (read: VjSetlistRead | null) => void = () => undefined;
        reads.readSetlist.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseRead = resolve;
            }),
        );
        playSetlist(remote, setlist);
        await jest.advanceTimersByTimeAsync(STEP_MS - EARLY_MS);
        const nextStep: VjSetlistReadPosition = {
          kind: 'index',
          index: 1,
          wrapsToFirst: false,
        };
        const stepped = frameOf(
          remote.send(
            'stage:setlistNext',
            {},
            Date.now(),
            setlistAnswers(setlist, nextStep),
          ),
        );
        expect(stepped.state.setlistIndex).toBe(1);

        releaseRead(setlistReadAt(setlist, nextStep));
        await jest.advanceTimersByTimeAsync(0);
        expect(setlistFramesOf(broadcasts)).toHaveLength(0);
        expect(stateOf(service).setlistIndex).toBe(1);

        await jest.advanceTimersByTimeAsync(STEP_MS - EARLY_MS);
        expect(reads.readSetlist).toHaveBeenCalledTimes(2);
        expect(itemAt(setlistFramesOf(broadcasts), 0).state.setlistIndex).toBe(
          2,
        );
      });

      it('stops the step timer on Pause and resumes it with the time left', async () => {
        const setlist = testSetlist(3);
        serveSetlist(reads, setlist);
        playSetlist(remote, setlist);
        jest.advanceTimersByTime(500);
        const paused = frameOf(
          remote.send(
            'stage:setlistSetPlaying',
            { isPlaying: false },
            Date.now(),
          ),
        );
        expect(paused.state.setlistPlayback).toMatchObject({
          status: 'paused',
          stepStartedAt: null,
          stepEndsAt: null,
          pausedRemainingMs: STEP_MS - 500,
        });
        expect(jest.getTimerCount()).toBe(0);
        await jest.advanceTimersByTimeAsync(10 * STEP_MS);
        expect(reads.readSetlist).not.toHaveBeenCalled();

        const resumedAt = Date.now();
        const resumed = frameOf(
          remote.send(
            'stage:setlistSetPlaying',
            { isPlaying: true },
            resumedAt,
          ),
        );
        expect(resumed.state.setlistPlayback).toMatchObject({
          status: 'playing',
          stepStartedAt: resumedAt - 500,
          stepEndsAt: resumedAt + STEP_MS - 500,
          stepDurationMs: STEP_MS,
          pausedRemainingMs: null,
        });
        await jest.advanceTimersByTimeAsync(STEP_MS - 500 - EARLY_MS);
        expect(itemAt(setlistFramesOf(broadcasts), 0).state.setlistIndex).toBe(
          1,
        );
      });

      it('stops the step timer when a clip tap takes the sequence over', async () => {
        const setlist = testSetlist(3);
        serveSetlist(reads, setlist);
        playSetlist(remote, setlist);
        const tappedClipId = randomUUID();
        const takenOver = frameOf(tapClip(remote, tappedClipId, Date.now()));
        expect(takenOver.state.liveClipId).toBe(tappedClipId);
        expect(takenOver.state.setlistPlayback).toMatchObject({
          status: 'takenOver',
          stepStartedAt: null,
          stepEndsAt: null,
        });
        expect(jest.getTimerCount()).toBe(0);
        await jest.advanceTimersByTimeAsync(10 * STEP_MS);
        expect(reads.readSetlist).not.toHaveBeenCalled();
        expect(stateOf(service).liveClipId).toBe(tappedClipId);
      });

      it('lands a sequence command and a library follow at once; only the timer waits for the step end', async () => {
        const setlist = testSetlist(3, { isLooping: true });
        serveSetlist(reads, setlist);
        playSetlist(remote, setlist);
        jest.advanceTimersByTime(500);
        const stepped = frameOf(
          remote.send(
            'stage:setlistNext',
            {},
            Date.now(),
            setlistAnswers(setlist, {
              kind: 'index',
              index: 1,
              wrapsToFirst: true,
            }),
          ),
        );
        expect(stepped.applyAt).toBeNull();
        expect(stepped.state.setlistPlayback).toMatchObject({
          stepStartedAt: START_AT + 500,
          stepEndsAt: START_AT + 500 + STEP_MS,
        });

        setlist.isLooping = false;
        const followed = itemAt(
          service.applyLibraryChange(
            setlistChange('setlist_updated', setlist),
            Date.now(),
            new Map([[setlist.setlistId, followReadOf(setlist)]]),
          ),
          0,
        ).frame;
        expect(followed.applyAt).toBeNull();
        expect(followed.state.setlistPlayback).toMatchObject({
          isLooping: false,
          stepEndsAt: START_AT + 500 + STEP_MS,
        });

        await jest.advanceTimersByTimeAsync(STEP_MS - EARLY_MS);
        const advanced = itemAt(setlistFramesOf(broadcasts), 0);
        expect(advanced.applyAt).toBe(START_AT + 500 + STEP_MS);
        expect(advanced.state.setlistIndex).toBe(2);
      });

      it('advances once at restore when the restored step end has passed', async () => {
        const setlist = testSetlist(3);
        serveSetlist(reads, setlist);
        const restoreState = {
          activeSetlistId: setlist.setlistId,
          setlistIndex: 0,
          setlistPlayback: {
            status: 'playing',
            itemId: itemAt(setlist.itemIds, 0),
            isFlashConfirmed: true,
            stepStartedAt: START_AT - 5 * STEP_MS,
            stepEndsAt: START_AT - 4 * STEP_MS,
            stepDurationMs: STEP_MS,
            pausedRemainingMs: null,
            isLooping: false,
          },
        };
        const restorePosition: VjSetlistReadPosition = {
          kind: 'index',
          index: 0,
          wrapsToFirst: false,
        };
        expect(service.restoreLookupsOf(restoreState, START_AT)).toEqual(
          expect.arrayContaining([
            {
              kind: 'setlistItem',
              setlistId: setlist.setlistId,
              position: restorePosition,
            },
          ]),
        );
        const restored = attachedOf(
          attachScreen(service, 'socket-a', randomUUID(), START_AT, {
            restoreState,
            restoreReads: setlistAnswers(setlist, restorePosition),
          }),
        );
        expect(restored.isRestored).toBe(true);
        expect(restored.state.setlistPlayback).toMatchObject({
          status: 'playing',
          isFlashConfirmed: false,
          stepEndsAt: START_AT - 4 * STEP_MS,
        });

        await jest.advanceTimersByTimeAsync(0);
        expect(reads.readSetlist).toHaveBeenCalledTimes(1);
        const frames = setlistFramesOf(broadcasts);
        expect(frames).toHaveLength(1);
        expect(itemAt(frames, 0).applyAt).toBeNull();
        expect(itemAt(frames, 0).state.setlistIndex).toBe(1);
        expect(itemAt(frames, 0).state.setlistPlayback).toMatchObject({
          status: 'playing',
          stepStartedAt: START_AT,
          stepEndsAt: START_AT + STEP_MS,
        });
        await jest.advanceTimersByTimeAsync(STEP_MS - EARLY_MS - 1);
        expect(setlistFramesOf(broadcasts)).toHaveLength(1);
      });

      it('keeps a restored step end that has not passed', async () => {
        const setlist = testSetlist(3);
        serveSetlist(reads, setlist);
        const restorePosition: VjSetlistReadPosition = {
          kind: 'index',
          index: 1,
          wrapsToFirst: false,
        };
        attachedOf(
          attachScreen(service, 'socket-a', randomUUID(), START_AT, {
            restoreState: {
              activeSetlistId: setlist.setlistId,
              setlistIndex: 1,
              setlistPlayback: {
                status: 'playing',
                stepStartedAt: START_AT - 1000,
                stepEndsAt: START_AT + STEP_MS - 1000,
                stepDurationMs: STEP_MS,
                isLooping: false,
              },
            },
            restoreReads: setlistAnswers(setlist, restorePosition),
          }),
        );
        await jest.advanceTimersByTimeAsync(STEP_MS - 1000 - EARLY_MS - 1);
        expect(reads.readSetlist).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        const advanced = itemAt(setlistFramesOf(broadcasts), 0);
        expect(advanced.applyAt).toBe(START_AT + STEP_MS - 1000);
        expect(advanced.state.setlistIndex).toBe(2);
      });

      it('clears the step timer with the stage', async () => {
        const setlist = testSetlist(3);
        serveSetlist(reads, setlist);
        playSetlist(remote, setlist);
        expect(jest.getTimerCount()).toBe(1);
        expect(service.dropStage(ADMIN_USER_ID)).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
        await jest.advanceTimersByTimeAsync(10 * STEP_MS);
        expect(reads.readSetlist).not.toHaveBeenCalled();
      });
    });

    it('clears every timer on eviction', () => {
      const remote = createRemote(service);
      remote.send('stage:setStrobe', { isStrobing: true }, Date.now());
      remote.send(
        'stage:setOverlay',
        { text: 'Hello', isVisible: true, hideAfterMs: 5000 },
        Date.now(),
      );
      remote.send(
        'stage:setCountdown',
        { isVisible: true, durationMs: 5000 },
        Date.now(),
      );
      expect(jest.getTimerCount()).toBe(3);
      service.detachSocket(ADMIN_USER_ID, 'remote-socket', START_AT);
      service.sweep(START_AT + VJ_STAGE_IDLE_EVICTION_MS + 1);
      expect(service.getState(ADMIN_USER_ID)).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(20_000);
      expect(broadcasts).toHaveLength(0);
    });
  });

  describe('status', () => {
    it('stores a screen status and cuts the clip list at 200', () => {
      const packId = randomUUID();
      attachScreen(service, 'socket-a', randomUUID(), 1);
      const clips = Array.from({ length: 250 }, () => clipStatus());
      expect(
        service.updateScreenStatus(
          ADMIN_USER_ID,
          'socket-a',
          { isFullscreen: true, preload: { packId, clips } },
          40,
        ),
      ).toEqual({ isStored: true, frame: null });
      const screen = itemAt(service.listScreens(ADMIN_USER_ID, 40), 0);
      expect(screen.isFullscreen).toBe(true);
      expect(screen.lastSeenAt).toBe(40);
      expect(screen.preload.clips).toHaveLength(200);
    });

    it('drops a malformed status', () => {
      attachScreen(service, 'socket-a', randomUUID(), 1);
      const before = service.listScreens(ADMIN_USER_ID, 1);
      for (const payload of [
        { isFullscreen: 'yes', preload: { packId: null, clips: [] } },
        { isFullscreen: true, preload: { packId: 'pack', clips: [] } },
        { isFullscreen: true },
      ]) {
        expect(
          service.updateScreenStatus(ADMIN_USER_ID, 'socket-a', payload, 50),
        ).toEqual({ isStored: false, frame: null });
      }
      expect(service.listScreens(ADMIN_USER_ID, 1)).toEqual(before);
      expect(
        service.updateScreenStatus(
          ADMIN_USER_ID,
          'socket-unknown',
          statusPayload(),
          50,
        ).isStored,
      ).toBe(false);
    });

    it('adopts the lead mic tempo with cause mic_tempo and ignores a follower', () => {
      attachScreen(service, 'socket-lead', randomUUID(), START_AT);
      attachScreen(service, 'socket-follow', randomUUID(), START_AT);
      service.attachRemote(ADMIN_USER_ID, 'remote-socket', START_AT);
      const remote = createRemote(service);
      expect(
        failureOf(remote.send('stage:setTempo', { source: 'mic' }, START_AT))
          .code,
      ).toBe('vj_mic_unavailable');
      service.updateScreenStatus(
        ADMIN_USER_ID,
        'socket-lead',
        statusPayload({
          mic: { level: 0.4, bpm: null, confidence: 0, beatAt: null },
        }),
        START_AT,
      );
      appliedOf(remote.send('stage:setTempo', { source: 'mic' }, START_AT));

      const heard = {
        mic: { level: 0.5, bpm: 130, confidence: 0.9, beatAt: START_AT + 100 },
      };
      expect(
        service.updateScreenStatus(
          ADMIN_USER_ID,
          'socket-follow',
          statusPayload(heard),
          START_AT + 100,
        ),
      ).toEqual({ isStored: true, frame: null });
      expect(stateOf(service).tempo.bpm).toBe(124);

      const adopted = service.updateScreenStatus(
        ADMIN_USER_ID,
        'socket-lead',
        statusPayload(heard),
        START_AT + 100,
      );
      expect(adopted.frame?.cause).toBe('mic_tempo');
      expect(adopted.frame?.sourceClientId).toBeNull();
      expect(adopted.frame?.state.tempo).toMatchObject({
        bpm: 130,
        source: 'mic',
      });
      expect(
        service.updateScreenStatus(
          ADMIN_USER_ID,
          'socket-lead',
          statusPayload({ mic: { ...heard.mic, bpm: 140 } }),
          START_AT + 1000,
        ).frame,
      ).toBeNull();
    });

    it('relays health and the lead next clip in the screen list', () => {
      attachScreen(service, 'socket-lead', randomUUID(), 0);
      attachScreen(service, 'socket-follow', randomUUID(), 1);
      service.attachRemote(ADMIN_USER_ID, 'remote-socket', 0);
      const remote = createRemote(service);
      appliedOf(remote.send('stage:setShuffle', { isOn: true }, START_AT));
      const leadNextClipId = randomUUID();
      service.updateScreenStatus(
        ADMIN_USER_ID,
        'socket-lead',
        statusPayload({
          nextClipId: leadNextClipId,
          health: {
            renderer: 'webgl2',
            fps: 59.94,
            droppedFrames: 3,
            cacheBytes: 1000,
            isEffectLoadHigh: false,
          },
        }),
        2,
      );
      service.updateScreenStatus(
        ADMIN_USER_ID,
        'socket-follow',
        statusPayload({ nextClipId: randomUUID() }),
        2,
      );
      const screens = service.listScreens(ADMIN_USER_ID, 2);
      expect(itemAt(screens, 0)).toMatchObject({
        isLead: true,
        nextClipId: leadNextClipId,
        health: { renderer: 'webgl2', fps: 59.9 },
      });
      expect(itemAt(screens, 1)).toMatchObject({
        isLead: false,
        nextClipId: null,
        health: null,
      });

      appliedOf(remote.send('stage:setShuffle', { isOn: false }, START_AT));
      expect(itemAt(service.listScreens(ADMIN_USER_ID, 3), 0).nextClipId).toBe(
        null,
      );
    });
  });

  describe('overrides and identify', () => {
    it('drops overrides of pruned screens at the next change', () => {
      const keptScreenId = randomUUID();
      const leavingScreenId = randomUUID();
      attachScreen(service, 'socket-kept', keptScreenId, START_AT);
      attachScreen(service, 'socket-leaving', leavingScreenId, START_AT);
      service.attachRemote(ADMIN_USER_ID, 'remote-socket', START_AT);
      const remote = createRemote(service);
      setBeatTempo(remote);
      const clipId = randomUUID();
      for (const screenId of [keptScreenId, leavingScreenId]) {
        appliedOf(
          remote.send(
            'stage:setScreenOverride',
            {
              screenId,
              override: { clipId, generatorId: null, generatorVariant: null },
            },
            START_AT,
            clipsExist(clipId),
          ),
        );
      }
      service.detachSocket(ADMIN_USER_ID, 'socket-leaving', START_AT);
      const prunedAt = START_AT + VJ_SCREEN_OFFLINE_RETENTION_MS + 1;
      expect(service.listScreens(ADMIN_USER_ID, prunedAt)).toHaveLength(1);
      expect(Object.keys(stateOf(service).screenOverrides)).toHaveLength(2);

      const pad = frameOf(
        remote.send('stage:setEffects', { speed: 2 }, prunedAt),
      );
      expect(pad.applyAt).toBeNull();
      expect(Object.keys(pad.state.screenOverrides)).toEqual([keptScreenId]);
    });

    it('drops the override of a screen past its retention at the next change without a list read', () => {
      const keptScreenId = randomUUID();
      const leavingScreenId = randomUUID();
      attachScreen(service, 'socket-kept', keptScreenId, START_AT);
      attachScreen(service, 'socket-leaving', leavingScreenId, START_AT);
      service.attachRemote(ADMIN_USER_ID, 'remote-socket', START_AT);
      const remote = createRemote(service);
      const clipId = randomUUID();
      for (const screenId of [keptScreenId, leavingScreenId]) {
        appliedOf(
          remote.send(
            'stage:setScreenOverride',
            {
              screenId,
              override: { clipId, generatorId: null, generatorVariant: null },
            },
            START_AT,
            clipsExist(clipId),
          ),
        );
      }
      service.detachSocket(ADMIN_USER_ID, 'socket-leaving', START_AT);
      const prunedAt = START_AT + VJ_SCREEN_OFFLINE_RETENTION_MS + 1;

      const pad = frameOf(
        remote.send('stage:setEffects', { speed: 2 }, prunedAt),
      );
      expect(Object.keys(pad.state.screenOverrides)).toEqual([keptScreenId]);
      expect(
        service
          .listScreens(ADMIN_USER_ID, prunedAt)
          .map((screen) => screen.screenId),
      ).toEqual([keptScreenId]);
    });

    it('answers identify targets for one screen or every connected screen', () => {
      const screenB = randomUUID();
      const screenC = randomUUID();
      attachScreen(service, 'socket-a', randomUUID(), 0);
      attachScreen(service, 'socket-b', screenB, 1);
      attachScreen(service, 'socket-c', screenC, 2);
      service.detachSocket(ADMIN_USER_ID, 'socket-c', 3);

      expect(service.identifyTargets(ADMIN_USER_ID, null)).toEqual({
        failure: null,
        targets: [
          { socketId: 'socket-a', number: 1 },
          { socketId: 'socket-b', number: 2 },
        ],
      });
      expect(
        service.identifyTargets(ADMIN_USER_ID, screenB.toUpperCase()),
      ).toEqual({
        failure: null,
        targets: [{ socketId: 'socket-b', number: 2 }],
      });
      for (const screenId of [screenC, randomUUID(), 'screen-1', 7]) {
        expect(
          service.identifyTargets(ADMIN_USER_ID, screenId).failure?.code,
        ).toBe('vj_screen_not_attached');
      }
      expect(service.identifyTargets(randomUUID(), null).failure?.code).toBe(
        'vj_not_attached',
      );
    });

    it('answers render mode targets for every connected screen', () => {
      attachScreen(service, 'socket-a', randomUUID(), 0);
      attachScreen(service, 'socket-b', randomUUID(), 1);
      attachScreen(service, 'socket-c', randomUUID(), 2);
      service.detachSocket(ADMIN_USER_ID, 'socket-c', 3);

      expect(service.renderModeTargets(ADMIN_USER_ID)).toEqual({
        failure: null,
        targets: [
          { socketId: 'socket-a', number: 1 },
          { socketId: 'socket-b', number: 2 },
        ],
      });

      service.detachSocket(ADMIN_USER_ID, 'socket-a', 4);
      service.detachSocket(ADMIN_USER_ID, 'socket-b', 5);

      expect(service.renderModeTargets(ADMIN_USER_ID).failure?.code).toBe(
        'vj_no_screens_connected',
      );
      expect(service.renderModeTargets(randomUUID()).failure?.code).toBe(
        'vj_not_attached',
      );
    });
  });

  describe('library', () => {
    beforeEach(() => {
      service.attachRemote(ADMIN_USER_ID, 'remote-socket', 0);
    });

    it('follows a removed step to the one before it and clears the active set list on its delete', () => {
      const remote = createRemote(service);
      const setlist = testSetlist(3);
      showSetlistStep(remote, setlist, 2);
      expect(
        service.activeSetlistIdsAmong([
          setlist.setlistId.toUpperCase(),
          randomUUID(),
        ]),
      ).toEqual([setlist.setlistId]);

      setlist.itemIds = setlist.itemIds.slice(0, 2);
      const shrunk = service.applyLibraryChange(
        setlistChange('setlist_items_changed', setlist),
        START_AT + 1,
        new Map([[setlist.setlistId, followReadOf(setlist)]]),
      );
      expect(shrunk).toHaveLength(1);
      expect(itemAt(shrunk, 0).frame.cause).toBe('library');
      expect(itemAt(shrunk, 0).frame.state).toMatchObject({
        activeSetlistId: setlist.setlistId,
        setlistIndex: 1,
      });
      expect(itemAt(shrunk, 0).frame.state.setlistPlayback.itemId).toBeNull();

      const deleted = service.applyLibraryChange(
        setlistChange('setlist_deleted', setlist),
        START_AT + 2,
        new Map(),
      );
      expect(itemAt(deleted, 0).frame.state.activeSetlistId).toBeNull();
      expect(service.activeSetlistIdsAmong([setlist.setlistId])).toEqual([]);
    });

    it('follows with the item ids the last follow read gave', () => {
      const remote = createRemote(service);
      const setlist = testSetlist(4);
      const firstId = itemAt(setlist.itemIds, 0);
      const secondId = itemAt(setlist.itemIds, 1);
      const thirdId = itemAt(setlist.itemIds, 2);
      const fourthId = itemAt(setlist.itemIds, 3);
      showSetlistStep(remote, setlist, 2);

      const insertedId = randomUUID();
      setlist.itemIds = [firstId, insertedId, secondId, thirdId, fourthId];
      const inserted = itemAt(
        service.applyLibraryChange(
          setlistChange('setlist_items_changed', setlist),
          START_AT + 1,
          new Map([[setlist.setlistId, followReadOf(setlist)]]),
        ),
        0,
      ).frame.state;
      expect(inserted.setlistIndex).toBe(3);
      expect(inserted.setlistPlayback.itemId).toBe(thirdId);

      // The step on screen and the one before it go; the nearest kept step
      // before it in the list the stage last read is the inserted one.
      setlist.itemIds = [firstId, insertedId, fourthId];
      const removed = itemAt(
        service.applyLibraryChange(
          setlistChange('setlist_items_changed', setlist),
          START_AT + 2,
          new Map([[setlist.setlistId, followReadOf(setlist)]]),
        ),
        0,
      ).frame.state;
      expect(removed.setlistIndex).toBe(1);
      expect(removed.setlistPlayback.itemId).toBeNull();
    });

    it('follows a clip delete that removed a step of the active sequence', () => {
      const remote = createRemote(service);
      const setlist = testSetlist(3);
      const deletedClipId = clipOfStep(setlist, 1);
      const shownClipId = clipOfStep(setlist, 2);
      showSetlistStep(remote, setlist, 2);

      setlist.itemIds = [
        itemAt(setlist.itemIds, 0),
        itemAt(setlist.itemIds, 2),
      ];
      const followed = itemAt(
        service.applyLibraryChange(
          setlistChange('clip_deleted', setlist, { clipId: deletedClipId }),
          START_AT + 1,
          new Map([[setlist.setlistId, followReadOf(setlist)]]),
        ),
        0,
      ).frame.state;
      expect(followed.liveClipId).toBe(shownClipId);
      expect(followed.setlistIndex).toBe(1);
      expect(followed.setlistPlayback.itemId).toBe(itemAt(setlist.itemIds, 1));
    });

    it('clears the selection when the follow read of a clip delete finds no set list', () => {
      const remote = createRemote(service);
      const setlist = testSetlist(2);
      showSetlistStep(remote, setlist, 1);
      const cleared = itemAt(
        service.applyLibraryChange(
          setlistChange('clip_deleted', setlist, {
            clipId: clipOfStep(setlist, 0),
          }),
          START_AT + 1,
          new Map([[setlist.setlistId, null]]),
        ),
        0,
      ).frame.state;
      expect(cleared.activeSetlistId).toBeNull();
      expect(cleared.setlistIndex).toBeNull();
      expect(cleared.setlistPlayback.status).toBe('manual');
    });

    it('replaces the item ids when another set list is selected and forgets them on Stop', () => {
      const remote = createRemote(service);
      const first = testSetlist(3);
      const second = testSetlist(4);
      showSetlistStep(remote, first, 0);
      expect(service.getSetlistItemIds(ADMIN_USER_ID)).toEqual(first.itemIds);

      showSetlistStep(remote, second, 2);
      expect(service.getSetlistItemIds(ADMIN_USER_ID)).toEqual(second.itemIds);
      // The step on screen and the one before it go: the follow anchors on
      // the second list's ids and lands on its first step.
      second.itemIds = [itemAt(second.itemIds, 0), itemAt(second.itemIds, 3)];
      const followed = itemAt(
        service.applyLibraryChange(
          setlistChange('setlist_items_changed', second),
          START_AT + 1,
          new Map([[second.setlistId, followReadOf(second)]]),
        ),
        0,
      ).frame.state;
      expect(followed.setlistIndex).toBe(0);
      expect(service.getSetlistItemIds(ADMIN_USER_ID)).toEqual(second.itemIds);

      appliedOf(
        remote.send(
          'stage:setlistSelect',
          { setlistId: null, index: null },
          START_AT,
        ),
      );
      expect(service.getSetlistItemIds(ADMIN_USER_ID)).toBeNull();
    });

    it('refreshes the item ids on a landing that changes nothing', () => {
      const remote = createRemote(service);
      const setlist = testSetlist(2);
      const arm = { setlistId: setlist.setlistId, index: null };
      appliedOf(
        remote.send(
          'stage:setlistSelect',
          arm,
          START_AT,
          setlistAnswers(setlist, { kind: 'count' }),
        ),
      );
      setlist.itemIds = [...setlist.itemIds, randomUUID()];
      const again = appliedOf(
        remote.send(
          'stage:setlistSelect',
          arm,
          START_AT,
          setlistAnswers(setlist, { kind: 'count' }),
        ),
      );
      expect(again.success.isNoop).toBe(true);
      expect(service.getSetlistItemIds(ADMIN_USER_ID)).toEqual(setlist.itemIds);
    });

    it('feeds the item ids of a restore to a later follow', () => {
      const setlist = testSetlist(4);
      const restorePosition: VjSetlistReadPosition = {
        kind: 'index',
        index: 2,
        wrapsToFirst: false,
      };
      const restored = attachedOf(
        attachScreen(service, 'socket-a', randomUUID(), START_AT, {
          restoreState: {
            activeSetlistId: setlist.setlistId,
            setlistIndex: 2,
            setlistPlayback: { status: 'manual' },
          },
          restoreReads: setlistAnswers(setlist, restorePosition),
        }),
      );
      expect(restored.state.setlistPlayback.itemId).toBe(
        itemAt(setlist.itemIds, 2),
      );
      expect(service.getSetlistItemIds(ADMIN_USER_ID)).toEqual(setlist.itemIds);

      // The step on screen and the one before it go: the restored ids find
      // step 1 as the nearest kept step before it.
      setlist.itemIds = [
        itemAt(setlist.itemIds, 0),
        itemAt(setlist.itemIds, 3),
      ];
      const followed = itemAt(
        service.applyLibraryChange(
          setlistChange('setlist_items_changed', setlist),
          START_AT + 1,
          new Map([[setlist.setlistId, followReadOf(setlist)]]),
        ),
        0,
      ).frame.state;
      expect(followed.setlistIndex).toBe(0);
    });

    it('answers vj_stale_setlist and lands nothing when a library follow landed while a command read the active set list', async () => {
      const remote = createRemote(service);
      const setlist = testSetlist(4);
      const secondId = itemAt(setlist.itemIds, 1);
      const thirdId = itemAt(setlist.itemIds, 2);
      const fourthId = itemAt(setlist.itemIds, 3);
      const lastClipId = clipOfStep(setlist, 3);
      showSetlistStep(remote, setlist, 2);
      let releaseRead: (read: VjSetlistRead | null) => void = () => undefined;
      reads.readSetlist.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseRead = resolve;
          }),
      );
      const payload = remote.nextPayload({});
      const pending = service.runRemoteCommand(
        ADMIN_USER_ID,
        'stage:setlistNext',
        payload,
        () => START_AT,
      );
      const olderRead = setlistReadAt(setlist, {
        kind: 'index',
        index: 3,
        wrapsToFirst: false,
      });

      setlist.itemIds = [secondId, thirdId, fourthId];
      const followed = service.applyLibraryChange(
        setlistChange('setlist_items_changed', setlist),
        START_AT,
        new Map([[setlist.setlistId, followReadOf(setlist)]]),
      );
      expect(itemAt(followed, 0).frame.state.setlistIndex).toBe(1);
      releaseRead(olderRead);
      const stale = failureOf(await pending);

      expect(stale.code).toBe('vj_stale_setlist');
      expect(stale.state?.setlistIndex).toBe(1);
      expect(stateOf(service).setlistIndex).toBe(1);
      expect(stateOf(service).setlistPlayback.itemId).toBe(thirdId);
      expect(service.getSetlistItemIds(ADMIN_USER_ID)).toEqual([
        secondId,
        thirdId,
        fourthId,
      ]);
      expect(
        failureOf(
          service.applyRemoteCommand(
            ADMIN_USER_ID,
            'stage:setlistNext',
            payload,
            EMPTY_VJ_LOOKUP_RESULTS,
            START_AT,
          ),
        ).code,
      ).toBe('vj_stale_command');

      const retried = frameOf(
        remote.send(
          'stage:setlistNext',
          {},
          START_AT,
          setlistAnswers(setlist, {
            kind: 'index',
            index: 2,
            wrapsToFirst: false,
          }),
        ),
      );
      expect(retried.state.setlistIndex).toBe(2);
      expect(retried.state.liveClipId).toBe(lastClipId);
    });

    it('lands a command whose read started after the last library follow', async () => {
      const remote = createRemote(service);
      const setlist = testSetlist(4);
      showSetlistStep(remote, setlist, 2);
      setlist.itemIds = setlist.itemIds.slice(1);
      service.applyLibraryChange(
        setlistChange('setlist_items_changed', setlist),
        START_AT,
        new Map([[setlist.setlistId, followReadOf(setlist)]]),
      );
      serveSetlist(reads, setlist);

      const stepped = appliedOf(
        await service.runRemoteCommand(
          ADMIN_USER_ID,
          'stage:setlistNext',
          remote.nextPayload({}),
          () => START_AT,
        ),
      );
      expect(stepped.frame?.state.setlistIndex).toBe(2);
    });

    it('lands a set list update on every stage with that set list active', () => {
      const otherAdminUserId = randomUUID();
      service.attachRemote(otherAdminUserId, 'other-remote-socket', 0);
      const setlist = testSetlist(2);
      showSetlistStep(createRemote(service), setlist, 0);
      showSetlistStep(createRemote(service, otherAdminUserId), setlist, 1);

      setlist.isLooping = true;
      const frames = service.applyLibraryChange(
        setlistChange('setlist_updated', setlist),
        START_AT + 1,
        new Map([[setlist.setlistId, followReadOf(setlist)]]),
      );
      expect(frames.map((entry) => entry.adminUserId).sort()).toEqual(
        [ADMIN_USER_ID, otherAdminUserId].sort(),
      );
      for (const { frame } of frames) {
        expect(frame.cause).toBe('library');
        expect(frame.state.setlistPlayback.isLooping).toBe(true);
      }
      expect(stateOf(service, otherAdminUserId).setlistIndex).toBe(1);
    });

    it('clears the mix, overrides, history and exclusions of a deleted clip', () => {
      const screenId = randomUUID();
      attachScreen(service, 'socket-a', screenId, 0);
      const remote = createRemote(service);
      const packId = randomUUID();
      const deletedClipId = randomUUID();
      const keptClipId = randomUUID();
      appliedOf(
        remote.send('stage:setPack', { packId }, START_AT, packExists(packId)),
      );
      appliedOf(tapClip(remote, deletedClipId, START_AT));
      appliedOf(tapClip(remote, keptClipId, START_AT));
      appliedOf(
        remote.send(
          'stage:setMix',
          { clipId: deletedClipId, amount: 0.5, blendMode: 'screen' },
          START_AT,
          clipsExist(deletedClipId),
        ),
      );
      appliedOf(
        remote.send(
          'stage:setScreenOverride',
          {
            screenId,
            override: {
              clipId: deletedClipId,
              generatorId: null,
              generatorVariant: null,
            },
          },
          START_AT,
          clipsExist(deletedClipId),
        ),
      );
      appliedOf(
        remote.send(
          'stage:setShuffle',
          { excludedClipIds: [deletedClipId] },
          START_AT,
          lookupResults({ clipIdsInPack: new Set([deletedClipId]) }),
        ),
      );

      const frames = service.applyLibraryChange(
        libraryChange({ kind: 'clip_deleted', clipId: deletedClipId }),
        START_AT + 1,
        new Map(),
      );
      const state = itemAt(frames, 0).frame.state;
      expect(state.liveClipId).toBe(keptClipId);
      expect(state.mix).toEqual({
        clipId: null,
        amount: 0,
        blendMode: 'screen',
      });
      expect(state.screenOverrides).toEqual({});
      expect(state.recentClipIds).toEqual([keptClipId]);
      expect(state.shuffle.excludedClipIds).toEqual([]);
    });

    it('leaves stages alone for unrelated changes', () => {
      const before = stateOf(service);
      expect(
        service.applyLibraryChange(
          libraryChange({ kind: 'pack_created', packId: randomUUID() }),
          1,
          new Map(),
        ),
      ).toEqual([]);
      expect(stateOf(service)).toEqual(before);
    });
  });

  describe('sweep', () => {
    it('evicts a stage idle for six hours and prunes offline screens after ten minutes', () => {
      const startedAt = 1_000_000;
      const attachedAdmin = randomUUID();
      const idleAdmin = randomUUID();
      service.attachRemote(attachedAdmin, 'remote-attached', startedAt);
      attachScreen(service, 'screen-socket', randomUUID(), startedAt, {
        adminUserId: attachedAdmin,
      });
      service.detachSocket(attachedAdmin, 'screen-socket', startedAt + 10);
      service.attachRemote(idleAdmin, 'remote-idle', startedAt);
      service.detachSocket(idleAdmin, 'remote-idle', startedAt);

      const sweepAt = startedAt + VJ_STAGE_IDLE_EVICTION_MS + 1;
      service.sweep(sweepAt);
      expect(service.getState(attachedAdmin)).not.toBeNull();
      expect(service.listScreens(attachedAdmin, sweepAt)).toEqual([]);
      expect(service.getState(idleAdmin)).toBeNull();
    });

    it('prunes an offline screen lazily when the list is built', () => {
      attachScreen(service, 'socket-a', randomUUID(), 0);
      attachScreen(service, 'socket-b', randomUUID(), 1);
      service.detachSocket(ADMIN_USER_ID, 'socket-a', 100);
      expect(
        service.listScreens(
          ADMIN_USER_ID,
          100 + VJ_SCREEN_OFFLINE_RETENTION_MS,
        ),
      ).toHaveLength(2);
      const later = service.listScreens(
        ADMIN_USER_ID,
        101 + VJ_SCREEN_OFFLINE_RETENTION_MS,
      );
      expect(later).toHaveLength(1);
      expect(itemAt(later, 0).number).toBe(2);
    });
  });

  it('keeps refusal messages free of payload text', () => {
    service.attachRemote(ADMIN_USER_ID, 'remote-socket', 0);
    const remote = createRemote(service);
    const secret = 'SECRET LINE';
    const failures: VjAckFailure[] = [
      failureOf(remote.send('stage:setOverlay', { text: `${secret}\u0007` })),
      failureOf(
        remote.send('stage:setOverlay', { text: `${secret} `.repeat(8) }),
      ),
      failureOf(
        remote.send('stage:setCountdown', {
          label: 'SECRET\u0007LINE',
        }),
      ),
      failureOf(
        remote.send('stage:setCountdown', {
          label: `${secret} `.repeat(4),
        }),
      ),
      failureOf(remote.send('stage:recallScene', { sceneId: secret })),
      failureOf(
        service.applyRemoteCommand(
          ADMIN_USER_ID,
          'stage:setOverlay',
          { text: secret, clientId: secret, commandSequence: 1 },
          EMPTY_VJ_LOOKUP_RESULTS,
          0,
        ),
      ),
    ];
    expect(failures.map((failure) => failure.code)).toEqual([
      'vj_overlay_text_invalid',
      'vj_overlay_text_too_long',
      'vj_countdown_label_invalid',
      'vj_countdown_label_too_long',
      'vj_scene_not_found',
      'vj_client_id_invalid',
    ]);
    for (const failure of failures) {
      expect(failure.message).not.toContain('SECRET');
      expect(JSON.stringify(failure)).not.toContain('SECRET');
    }
  });
});
