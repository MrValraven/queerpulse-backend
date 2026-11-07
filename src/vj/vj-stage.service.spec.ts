import { randomUUID } from 'node:crypto';
import {
  createVjStageState,
  vjSceneLookOf,
  type VjAckFailure,
  type VjLibraryChange,
  type VjRemoteCommandName,
  type VjScreenClipStatus,
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
    readSetlistItem: jest.fn().mockResolvedValue(null),
    setlistItemCount: jest.fn().mockResolvedValue(null),
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
      const setlistId = randomUUID();
      const look = vjSceneLookOf(createVjStageState(randomUUID(), 0));
      const itemRead = (index: number | null) => ({
        setlistId,
        index,
        itemCount: 3,
        sceneId: index === null ? null : randomUUID(),
        look: index === null ? null : look,
      });
      appliedOf(
        first.send(
          'stage:setlistSelect',
          { setlistId, index: null },
          START_AT,
          lookupResults({
            setlistItems: new Map([
              [vjSetlistItemKey(setlistId, null), itemRead(null)],
            ]),
          }),
        ),
      );
      const stepPayload = first.nextPayload({});
      const prepared = service.prepareRemoteCommand(
        ADMIN_USER_ID,
        'stage:setlistNext',
        stepPayload,
        START_AT,
      );
      expect(prepared.lookups).toEqual([
        { kind: 'setlistItem', setlistId, index: 0 },
      ]);
      const firstItem = lookupResults({
        setlistItems: new Map([[vjSetlistItemKey(setlistId, 0), itemRead(0)]]),
      });
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
  });

  describe('library', () => {
    beforeEach(() => {
      service.attachRemote(ADMIN_USER_ID, 'remote-socket', 0);
    });

    it('clears the active set list on its delete and the index past a shrunk count', () => {
      const remote = createRemote(service);
      const setlistId = randomUUID();
      appliedOf(
        remote.send(
          'stage:setlistSelect',
          { setlistId, index: 2 },
          START_AT,
          lookupResults({
            setlistItems: new Map([
              [
                vjSetlistItemKey(setlistId, 2),
                {
                  setlistId,
                  index: 2,
                  itemCount: 3,
                  sceneId: randomUUID(),
                  look: vjSceneLookOf(createVjStageState(randomUUID(), 0)),
                },
              ],
            ]),
          }),
        ),
      );
      expect(
        service.activeSetlistIdsAmong([setlistId.toUpperCase(), randomUUID()]),
      ).toEqual([setlistId]);

      const shrunk = service.applyLibraryChange(
        libraryChange({
          kind: 'setlist_items_changed',
          setlistId,
          setlistIds: [setlistId],
        }),
        START_AT + 1,
        new Map([[setlistId, 2]]),
      );
      expect(shrunk).toHaveLength(1);
      expect(itemAt(shrunk, 0).frame.cause).toBe('library');
      expect(itemAt(shrunk, 0).frame.state).toMatchObject({
        activeSetlistId: setlistId,
        setlistIndex: null,
      });

      const deleted = service.applyLibraryChange(
        libraryChange({
          kind: 'setlist_deleted',
          setlistId,
          setlistIds: [setlistId],
        }),
        START_AT + 2,
        new Map(),
      );
      expect(itemAt(deleted, 0).frame.state.activeSetlistId).toBeNull();
      expect(service.activeSetlistIdsAmong([setlistId])).toEqual([]);
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
