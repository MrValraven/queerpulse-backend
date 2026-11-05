import { randomUUID } from 'node:crypto';
import type {
  VjAckFailure,
  VjRemoteCommandName,
  VjScreenClipStatus,
  VjStageFrame,
  VjStageState,
} from './vj.contract';
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

interface RecordedBroadcast {
  adminUserId: string;
  frame: VjStageFrame;
}

function createService(): {
  service: VjStageService;
  broadcasts: RecordedBroadcast[];
} {
  const service = new VjStageService();
  const broadcasts: RecordedBroadcast[] = [];
  service.bindBroadcaster({
    broadcastState: (adminUserId, frame) => {
      broadcasts.push({ adminUserId, frame });
    },
  });
  return { service, broadcasts };
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
    isActivePackKnown?: boolean;
    isLiveClipKnown?: boolean;
  } = {},
): VjScreenAttachOutcome {
  return service.attachScreen(
    {
      adminUserId: options.adminUserId ?? ADMIN_USER_ID,
      socketId,
      screenId,
      restoreState: options.restoreState ?? null,
      restoreLookups: {
        isActivePackKnown: options.isActivePackKnown ?? true,
        isLiveClipKnown: options.isLiveClipKnown ?? true,
      },
    },
    now,
  );
}

/** A remote page: one client id, a sequence that grows by one per command. */
function createRemote(service: VjStageService, adminUserId = ADMIN_USER_ID) {
  const clientId = randomUUID();
  let commandSequence = 0;
  return {
    clientId,
    send(
      name: VjRemoteCommandName,
      fields: Record<string, unknown>,
      now = 1000,
      isLookupKnown = true,
    ): VjStageOutcome {
      commandSequence += 1;
      return service.applyRemoteCommand(
        adminUserId,
        name,
        { ...fields, clientId, commandSequence },
        isLookupKnown,
        now,
      );
    },
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

  beforeEach(() => {
    ({ service, broadcasts } = createService());
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
      expect(first.state.revision).toBe(0);
      expect(first.state.clipSequence).toBe(0);
      expect(first.state.stageEpoch).toMatch(UUID_SHAPE);

      const second = attachedOf(
        attachScreen(service, 'socket-b', randomUUID(), 2),
      );
      expect(second.isLead).toBe(false);
      expect(second.leadChange).toBeNull();

      const screens = service.listScreens(ADMIN_USER_ID, 3);
      expect(screens.map((screen) => screen.number)).toEqual([1, 2]);
      expect(screens.map((screen) => screen.isLead)).toEqual([true, false]);
      expect(screens[0]).toMatchObject({
        isConnected: true,
        isFullscreen: false,
        connectedAt: 1,
        lastSeenAt: 1,
        preload: { packId: null, clips: [] },
      });
      expect(service.leadSocketIdOf(ADMIN_USER_ID)).toBe('socket-a');
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
      const screenA = randomUUID();
      attachScreen(service, 'socket-a', screenA, 1);
      attachScreen(service, 'socket-b', randomUUID(), 2);
      attachScreen(service, 'socket-c', randomUUID(), 3);

      expect(service.detachSocket(ADMIN_USER_ID, 'socket-a', 4)).toEqual({
        leadChange: { promotedSocketId: 'socket-b' },
        hasScreenListChanged: true,
      });
      const screens = service.listScreens(ADMIN_USER_ID, 4);
      expect(screens[0]).toMatchObject({
        screenId: screenA,
        number: 1,
        isConnected: false,
        isLead: false,
        connectedAt: null,
      });
      expect(screens[1]).toMatchObject({ isConnected: true, isLead: true });
      expect(screens[2]).toMatchObject({ isConnected: true, isLead: false });
      expect(service.leadSocketIdOf(ADMIN_USER_ID)).toBe('socket-b');

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

    it('lets a former lead come back as a follower', () => {
      const screenA = randomUUID();
      attachScreen(service, 'socket-a', screenA, 1);
      attachScreen(service, 'socket-b', randomUUID(), 2);
      service.detachSocket(ADMIN_USER_ID, 'socket-a', 3);

      const back = attachedOf(attachScreen(service, 'socket-a2', screenA, 4));
      expect(back.isLead).toBe(false);
      expect(back.leadChange).toBeNull();
      expect(back.replacedSocketId).toBeNull();

      const screens = service.listScreens(ADMIN_USER_ID, 4);
      expect(screens[0]).toMatchObject({
        screenId: screenA,
        number: 1,
        isConnected: true,
        isLead: false,
        connectedAt: 4,
      });
      expect(screens[1]).toMatchObject({ number: 2, isLead: true });
    });

    it('keeps the new socket connected when the replaced one disconnects late', () => {
      const screenA = randomUUID();
      attachScreen(service, 'socket-1', screenA, 1);
      const replacing = attachedOf(
        attachScreen(service, 'socket-2', screenA, 2),
      );
      expect(replacing.replacedSocketId).toBe('socket-1');
      expect(replacing.isLead).toBe(true);
      expect(replacing.leadChange).toBeNull();

      expect(service.detachSocket(ADMIN_USER_ID, 'socket-1', 3)).toEqual({
        leadChange: null,
        hasScreenListChanged: false,
      });
      const screens = service.listScreens(ADMIN_USER_ID, 3);
      expect(screens).toHaveLength(1);
      expect(screens[0]).toMatchObject({
        number: 1,
        isConnected: true,
        isLead: true,
        connectedAt: 2,
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
  });

  describe('restore', () => {
    it('adopts a saved state only at revision 0', () => {
      const packId = randomUUID();
      const clipId = randomUUID();
      const savedEpoch = randomUUID();
      expect(service.shouldAdoptRestore(ADMIN_USER_ID)).toBe(true);
      const restoreState = {
        stageEpoch: savedEpoch,
        revision: 14,
        activePackId: packId,
        liveClipId: clipId,
        transition: { mode: 'cut', fadeMs: 300 },
        overlay: { text: 'Hello', style: 'ticker', isVisible: true },
        effects: {
          speed: 2,
          isMonochrome: true,
          isMirrored: false,
          isHueCycling: true,
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
      expect(service.restoreLookupIds(restoreState)).toEqual({
        packId,
        clipId,
      });

      const restored = attachedOf(
        attachScreen(service, 'socket-a', randomUUID(), 50, { restoreState }),
      );
      expect(restored.isRestored).toBe(true);
      expect(restored.state).toEqual({
        stageEpoch: expect.stringMatching(UUID_SHAPE) as string,
        revision: 1,
        clipSequence: 1,
        activePackId: packId,
        liveClipId: clipId,
        transition: { mode: 'cut', fadeMs: 300 },
        overlay: { text: 'Hello', style: 'ticker', isVisible: true },
        effects: {
          speed: 2,
          isMonochrome: true,
          isMirrored: false,
          isHueCycling: true,
          isStrobing: false,
          isBlackout: false,
          strobeStartedAt: null,
        },
        shuffle: {
          isOn: true,
          intervalKind: 'beats',
          intervalValue: 16,
          bpm: 128,
        },
        updatedAt: 50,
      });
      expect(restored.state.stageEpoch).not.toBe(savedEpoch);
      expect(service.shouldAdoptRestore(ADMIN_USER_ID)).toBe(false);

      const later = attachedOf(
        attachScreen(service, 'socket-b', randomUUID(), 60, {
          restoreState: { ...restoreState, liveClipId: null },
        }),
      );
      expect(later.isRestored).toBe(false);
      expect(later.state).toEqual(restored.state);
      expect(stateOf(service).liveClipId).toBe(clipId);
    });

    it('drops unknown ids and takes defaults for bad fields on restore', () => {
      const clipId = randomUUID();
      const restored = attachedOf(
        attachScreen(service, 'socket-a', randomUUID(), 50, {
          restoreState: {
            stageEpoch: randomUUID(),
            revision: 3,
            activePackId: randomUUID(),
            liveClipId: clipId,
            transition: { mode: 'cut', fadeMs: 9000 },
            overlay: { text: 'a\nb', style: 'big', isVisible: true },
            effects: { speed: 3, isMirrored: 'yes', isBlackout: true },
            shuffle: {
              isOn: 'yes',
              intervalKind: 'seconds',
              intervalValue: 61,
              bpm: 300,
            },
          },
          isActivePackKnown: false,
          isLiveClipKnown: true,
        }),
      );
      expect(restored.isRestored).toBe(true);
      expect(restored.state.activePackId).toBeNull();
      expect(restored.state.liveClipId).toBe(clipId);
      expect(restored.state.transition).toEqual({ mode: 'cut', fadeMs: 800 });
      expect(restored.state.overlay).toEqual({
        text: '',
        style: 'big',
        isVisible: false,
      });
      expect(restored.state.effects).toMatchObject({
        speed: 1,
        isMirrored: false,
        isBlackout: true,
        isStrobing: false,
      });
      expect(restored.state.shuffle).toEqual({
        isOn: false,
        intervalKind: 'seconds',
        intervalValue: 8,
        bpm: 124,
      });
    });

    it('reads uuid-shaped restore ids only', () => {
      expect(
        service.restoreLookupIds({ activePackId: 'pack', liveClipId: 7 }),
      ).toEqual({ packId: null, clipId: null });
      expect(service.restoreLookupIds('not a state')).toEqual({
        packId: null,
        clipId: null,
      });
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
          ).failure?.code,
        ).toBe('vj_client_id_invalid');
        expect(
          failureOf(
            service.applyRemoteCommand(
              ADMIN_USER_ID,
              'stage:setTransition',
              payload,
              true,
              1000,
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
          true,
          1000,
        );

      expect(appliedOf(apply(2, { mode: 'cut' })).success.revision).toBe(1);
      for (const commandSequence of [2, 1]) {
        expect(
          service.prepareRemoteCommand(ADMIN_USER_ID, 'stage:setTransition', {
            mode: 'fade',
            clientId,
            commandSequence,
          }).failure?.code,
        ).toBe('vj_stale_command');
        const failure = failureOf(apply(commandSequence, { mode: 'fade' }));
        expect(failure.code).toBe('vj_stale_command');
        expect(failure.state?.revision).toBe(1);
      }
      expect(stateOf(service).revision).toBe(1);
      expect(stateOf(service).transition.mode).toBe('cut');

      expect(failureOf(apply(3, { fadeMs: 9000 })).code).toBe(
        'vj_fade_out_of_range',
      );
      const replay = failureOf(apply(3, { mode: 'fade' }));
      expect(replay.code).toBe('vj_stale_command');
      expect(stateOf(service).revision).toBe(1);
      expect(appliedOf(apply(4, { mode: 'fade' })).success.revision).toBe(2);
    });

    it('records nothing while preparing a command', () => {
      const remote = createRemote(service);
      const payload = {
        mode: 'cut',
        clientId: remote.clientId,
        commandSequence: 1,
      };
      expect(
        service.prepareRemoteCommand(
          ADMIN_USER_ID,
          'stage:setTransition',
          payload,
        ),
      ).toEqual({ failure: null, lookup: null });
      expect(
        appliedOf(
          service.applyRemoteCommand(
            ADMIN_USER_ID,
            'stage:setTransition',
            payload,
            true,
            1000,
          ),
        ).success,
      ).toEqual({ revision: 1, isNoop: false });
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
      const firstRemote = itemAt(remotes, 0);
      const secondRemote = itemAt(remotes, 1);
      expect(
        service.prepareRemoteCommand(ADMIN_USER_ID, 'stage:setTransition', {
          mode: 'fade',
          clientId: secondRemote.clientId,
          commandSequence: 1,
        }).failure?.code,
      ).toBe('vj_stale_command');
      expect(
        service.applyRemoteCommand(
          ADMIN_USER_ID,
          'stage:setTransition',
          { mode: 'fade', clientId: firstRemote.clientId, commandSequence: 1 },
          true,
          1000,
        ).ok,
      ).toBe(true);
    });

    it('applies a change, bumps the revision and names the source client', () => {
      const remote = createRemote(service);
      expect(remote.send('stage:setTransition', { mode: 'cut' }, 5000)).toEqual(
        {
          ok: true,
          success: { revision: 1, isNoop: false },
          frame: {
            state: expect.objectContaining({
              revision: 1,
              updatedAt: 5000,
              transition: { mode: 'cut', fadeMs: 800 },
            }) as VjStageState,
            cause: 'command',
            sourceClientId: remote.clientId,
          },
        },
      );
      expect(stateOf(service).updatedAt).toBe(5000);
    });

    it('answers a noop with no frame and no revision change', () => {
      const remote = createRemote(service);
      remote.send('stage:setTransition', { mode: 'cut', fadeMs: 300 }, 5000);
      expect(
        remote.send('stage:setTransition', { mode: 'cut', fadeMs: 300 }, 6000),
      ).toEqual({
        ok: true,
        success: { revision: 1, isNoop: true },
        frame: null,
      });
      expect(stateOf(service).updatedAt).toBe(5000);
      expect(stateOf(service).revision).toBe(1);
    });

    it('answers vj_patch_empty for a patch with no recognised field', () => {
      const remote = createRemote(service);
      const patchCommands: VjRemoteCommandName[] = [
        'stage:setTransition',
        'stage:setOverlay',
        'stage:setEffects',
        'stage:setShuffle',
      ];
      for (const name of patchCommands) {
        expect(failureOf(remote.send(name, {})).code).toBe('vj_patch_empty');
        expect(failureOf(remote.send(name, { colour: 'red' })).code).toBe(
          'vj_patch_empty',
        );
      }
      expect(stateOf(service).revision).toBe(0);
    });

    it('bumps the clip sequence on every clip tap, the live one included', () => {
      const remote = createRemote(service);
      const clipId = randomUUID();
      const firstTap = appliedOf(remote.send('stage:goClip', { clipId }));
      expect(firstTap.success).toEqual({ revision: 1, isNoop: false });
      expect(stateOf(service)).toMatchObject({
        liveClipId: clipId,
        clipSequence: 1,
      });

      const reTap = appliedOf(remote.send('stage:goClip', { clipId }));
      expect(reTap.success).toEqual({ revision: 2, isNoop: false });
      expect(reTap.frame?.state.clipSequence).toBe(2);

      appliedOf(remote.send('stage:goClip', { clipId: null }));
      expect(stateOf(service)).toMatchObject({
        liveClipId: null,
        clipSequence: 3,
        revision: 3,
      });
    });

    it('answers vj_clip_not_found and vj_pack_not_found for unknown or malformed ids', () => {
      const remote = createRemote(service);
      const unknownId = randomUUID();
      const commandFields = { clientId: remote.clientId, commandSequence: 1 };

      expect(
        service.prepareRemoteCommand(ADMIN_USER_ID, 'stage:goClip', {
          ...commandFields,
          clipId: 'clip-7',
        }),
      ).toEqual({
        failure: expect.objectContaining({
          code: 'vj_clip_not_found',
        }) as VjAckFailure,
        lookup: null,
      });
      expect(
        service.prepareRemoteCommand(ADMIN_USER_ID, 'stage:setPack', {
          ...commandFields,
          packId: 12,
        }).failure?.code,
      ).toBe('vj_pack_not_found');
      expect(
        service.prepareRemoteCommand(ADMIN_USER_ID, 'stage:setPack', {
          ...commandFields,
        }).failure?.code,
      ).toBe('vj_pack_not_found');
      expect(
        service.prepareRemoteCommand(ADMIN_USER_ID, 'stage:goClip', {
          ...commandFields,
          clipId: unknownId,
        }),
      ).toEqual({ failure: null, lookup: { kind: 'clip', id: unknownId } });
      expect(
        service.prepareRemoteCommand(ADMIN_USER_ID, 'stage:setPack', {
          ...commandFields,
          packId: unknownId,
        }),
      ).toEqual({ failure: null, lookup: { kind: 'pack', id: unknownId } });
      expect(
        service.prepareRemoteCommand(ADMIN_USER_ID, 'stage:setPack', {
          ...commandFields,
          packId: null,
        }),
      ).toEqual({ failure: null, lookup: null });

      expect(
        failureOf(
          remote.send('stage:goClip', { clipId: unknownId }, 1000, false),
        ).code,
      ).toBe('vj_clip_not_found');
      expect(
        failureOf(
          remote.send('stage:setPack', { packId: unknownId }, 1000, false),
        ).code,
      ).toBe('vj_pack_not_found');
      expect(failureOf(remote.send('stage:goClip', { clipId: 'x' })).code).toBe(
        'vj_clip_not_found',
      );
      expect(stateOf(service).revision).toBe(0);
      expect(stateOf(service).clipSequence).toBe(0);
    });

    it('keeps the live clip when the pack changes', () => {
      const remote = createRemote(service);
      const clipId = randomUUID();
      const packId = randomUUID();
      remote.send('stage:goClip', { clipId });
      const packChange = appliedOf(remote.send('stage:setPack', { packId }));
      expect(packChange.success.isNoop).toBe(false);
      expect(stateOf(service)).toMatchObject({
        activePackId: packId,
        liveClipId: clipId,
        clipSequence: 2,
      });

      const samePack = appliedOf(remote.send('stage:setPack', { packId }));
      expect(samePack.success).toEqual({ revision: 2, isNoop: true });
      expect(samePack.frame).toBeNull();
      expect(stateOf(service).clipSequence).toBe(2);
    });

    it('checks overlay text', () => {
      const remote = createRemote(service);
      const codeOf = (fields: Record<string, unknown>) =>
        failureOf(remote.send('stage:setOverlay', fields)).code;

      for (const text of ['a\nb', 'a b', '\u0007', 5]) {
        expect(codeOf({ text })).toBe('vj_overlay_text_invalid');
      }
      expect(codeOf({ text: 'x'.repeat(81) })).toBe('vj_overlay_text_too_long');
      expect(codeOf({ isVisible: true })).toBe('vj_overlay_text_blank');
      expect(codeOf({ text: '   ', isVisible: true })).toBe(
        'vj_overlay_text_blank',
      );
      expect(codeOf({ style: 'marquee' })).toBe('vj_overlay_style_invalid');
      expect(codeOf({ isVisible: 'yes' })).toBe('vj_effect_flag_invalid');
      expect(stateOf(service).revision).toBe(0);

      const astralLine = '\u{10400}'.repeat(80);
      appliedOf(remote.send('stage:setOverlay', { text: astralLine }));
      expect(stateOf(service).overlay.text).toBe(astralLine);

      appliedOf(
        remote.send('stage:setOverlay', { text: '  Hi  ', isVisible: true }),
      );
      expect(stateOf(service).overlay).toEqual({
        text: 'Hi',
        style: 'big',
        isVisible: true,
      });
      expect(codeOf({ text: '' })).toBe('vj_overlay_text_blank');
    });

    it('checks effects', () => {
      const remote = createRemote(service);
      expect(
        failureOf(remote.send('stage:setEffects', { speed: 0.75 })).code,
      ).toBe('vj_speed_invalid');
      expect(
        failureOf(remote.send('stage:setEffects', { isMirrored: 1 })).code,
      ).toBe('vj_effect_flag_invalid');
      expect(
        failureOf(remote.send('stage:setStrobe', { isStrobing: 'on' })).code,
      ).toBe('vj_effect_flag_invalid');
      appliedOf(
        remote.send('stage:setEffects', { speed: 1.5, isMirrored: true }),
      );
      expect(stateOf(service).effects).toMatchObject({
        speed: 1.5,
        isMirrored: true,
        isMonochrome: false,
      });
    });

    it('checks shuffle settings', () => {
      const remote = createRemote(service);
      const shuffleOf = () => stateOf(service).shuffle;
      const codeOf = (fields: Record<string, unknown>) =>
        failureOf(remote.send('stage:setShuffle', fields)).code;

      appliedOf(remote.send('stage:setShuffle', { intervalValue: 45 }));
      appliedOf(remote.send('stage:setShuffle', { intervalKind: 'beats' }));
      expect(shuffleOf()).toMatchObject({
        intervalKind: 'beats',
        intervalValue: 8,
      });

      appliedOf(remote.send('stage:setShuffle', { intervalValue: 16 }));
      appliedOf(remote.send('stage:setShuffle', { intervalKind: 'seconds' }));
      expect(shuffleOf()).toMatchObject({
        intervalKind: 'seconds',
        intervalValue: 16,
      });

      expect(codeOf({ intervalValue: 61 })).toBe('vj_shuffle_interval_invalid');
      expect(codeOf({ intervalKind: 'beats', intervalValue: 12 })).toBe(
        'vj_shuffle_interval_invalid',
      );
      expect(codeOf({ intervalKind: 'bars' })).toBe(
        'vj_shuffle_interval_invalid',
      );
      for (const bpm of [59.9, Number.NaN, '124', 200.1]) {
        expect(codeOf({ bpm })).toBe('vj_bpm_out_of_range');
      }
      expect(codeOf({ isOn: 'yes' })).toBe('vj_effect_flag_invalid');

      appliedOf(remote.send('stage:setShuffle', { bpm: 124.26 }));
      expect(shuffleOf().bpm).toBe(124.3);
    });
  });

  describe('strobe', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(1000);
      service.attachRemote(ADMIN_USER_ID, 'remote-socket', 1000);
    });

    it('switches the strobe off after ten seconds with cause strobe_timeout', () => {
      const remote = createRemote(service);
      const on = appliedOf(
        remote.send('stage:setStrobe', { isStrobing: true }, 1000),
      );
      expect(on.frame?.state.effects).toMatchObject({
        isStrobing: true,
        strobeStartedAt: 1000,
      });

      jest.advanceTimersByTime(9999);
      expect(broadcasts).toHaveLength(0);
      jest.advanceTimersByTime(1);
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toEqual({
        adminUserId: ADMIN_USER_ID,
        frame: {
          state: expect.objectContaining({
            revision: 2,
            effects: expect.objectContaining({
              isStrobing: false,
              strobeStartedAt: null,
            }) as VjStageState['effects'],
          }) as VjStageState,
          cause: 'strobe_timeout',
          sourceClientId: null,
        },
      });
      expect(stateOf(service).revision).toBe(2);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('does not extend the strobe when it is turned on again', () => {
      const remote = createRemote(service);
      remote.send('stage:setStrobe', { isStrobing: true }, 1000);
      jest.advanceTimersByTime(5000);
      expect(
        remote.send('stage:setStrobe', { isStrobing: true }, 6000),
      ).toEqual({
        ok: true,
        success: { revision: 1, isNoop: true },
        frame: null,
      });
      expect(stateOf(service).effects.strobeStartedAt).toBe(1000);

      jest.advanceTimersByTime(4999);
      expect(broadcasts).toHaveLength(0);
      jest.advanceTimersByTime(1);
      expect(broadcasts).toHaveLength(1);
      expect(itemAt(broadcasts, 0).frame.cause).toBe('strobe_timeout');
    });

    it('clears the strobe timer when it is turned off', () => {
      const remote = createRemote(service);
      remote.send('stage:setStrobe', { isStrobing: true }, 1000);
      expect(jest.getTimerCount()).toBe(1);
      const off = appliedOf(
        remote.send('stage:setStrobe', { isStrobing: false }, 2000),
      );
      expect(off.frame?.state.effects).toMatchObject({
        isStrobing: false,
        strobeStartedAt: null,
      });
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(20_000);
      expect(broadcasts).toHaveLength(0);
      expect(stateOf(service).revision).toBe(2);
    });
  });

  describe('advance', () => {
    const packId = randomUUID();
    const clipId = randomUUID();
    let remote: ReturnType<typeof createRemote>;

    const advancePayload = (overrides: Record<string, unknown> = {}) => ({
      expectedClipSequence: stateOf(service).clipSequence,
      clipId,
      ...overrides,
    });

    beforeEach(() => {
      attachScreen(service, 'socket-lead', randomUUID(), 1);
      attachScreen(service, 'socket-follower', randomUUID(), 2);
      service.attachRemote(ADMIN_USER_ID, 'remote-socket', 3);
      remote = createRemote(service);
    });

    it('checks an advance in the contract order', () => {
      const prepare = (socketId: string, payload: Record<string, unknown>) =>
        service.prepareScreenAdvance(ADMIN_USER_ID, socketId, payload);

      const notLead = prepare('socket-follower', advancePayload());
      expect(notLead.failure?.code).toBe('vj_not_lead');
      expect(notLead.failure?.state).toEqual(stateOf(service));

      const shuffleOff = prepare('socket-lead', advancePayload());
      expect(shuffleOff.failure?.code).toBe('vj_shuffle_off');
      expect(shuffleOff.failure?.state).toEqual(stateOf(service));

      appliedOf(remote.send('stage:setShuffle', { isOn: true }));
      const noPack = prepare('socket-lead', advancePayload());
      expect(noPack.failure?.code).toBe('vj_no_active_pack');
      expect(noPack.failure?.state).toEqual(stateOf(service));

      appliedOf(remote.send('stage:setPack', { packId }));
      const current = stateOf(service).clipSequence;
      for (const expectedClipSequence of [current - 1, String(current), 1.5]) {
        const stale = prepare(
          'socket-lead',
          advancePayload({ expectedClipSequence }),
        );
        expect(stale.failure?.code).toBe('vj_stale_clip_sequence');
        expect(stale.failure?.state).toEqual(stateOf(service));
      }

      const malformedClip = prepare(
        'socket-lead',
        advancePayload({ clipId: 'clip' }),
      );
      expect(malformedClip.failure?.code).toBe('vj_clip_not_in_pack');
      expect(malformedClip.failure?.state).toBeUndefined();

      expect(prepare('socket-lead', advancePayload())).toEqual({
        failure: null,
        packId,
        clipId,
      });

      const revisionBefore = stateOf(service).revision;
      const outsidePack = failureOf(
        service.applyScreenAdvance(
          ADMIN_USER_ID,
          'socket-lead',
          advancePayload(),
          false,
          10,
        ),
      );
      expect(outsidePack.code).toBe('vj_clip_not_in_pack');
      expect(stateOf(service).revision).toBe(revisionBefore);
      expect(
        failureOf(
          service.applyScreenAdvance(
            ADMIN_USER_ID,
            'socket-follower',
            advancePayload(),
            true,
            10,
          ),
        ).code,
      ).toBe('vj_not_lead');
    });

    it('refuses an advance against an old clip sequence', () => {
      appliedOf(remote.send('stage:setShuffle', { isOn: true }));
      appliedOf(remote.send('stage:setPack', { packId }));
      const sequenceBefore = stateOf(service).clipSequence;
      const payload = advancePayload();
      expect(
        service.prepareScreenAdvance(ADMIN_USER_ID, 'socket-lead', payload)
          .failure,
      ).toBeNull();

      const tappedClipId = randomUUID();
      appliedOf(remote.send('stage:goClip', { clipId: tappedClipId }));
      const stale = failureOf(
        service.applyScreenAdvance(
          ADMIN_USER_ID,
          'socket-lead',
          payload,
          true,
          20,
        ),
      );
      expect(stale.code).toBe('vj_stale_clip_sequence');
      expect(stale.state?.liveClipId).toBe(tappedClipId);
      expect(stale.state?.clipSequence).toBe(sequenceBefore + 1);
      expect(stateOf(service).liveClipId).toBe(tappedClipId);
    });

    it('applies an advance with cause shuffle', () => {
      appliedOf(remote.send('stage:setShuffle', { isOn: true }));
      appliedOf(remote.send('stage:setPack', { packId }));
      const before = stateOf(service);
      const payload = advancePayload();

      const advanced = appliedOf(
        service.applyScreenAdvance(
          ADMIN_USER_ID,
          'socket-lead',
          payload,
          true,
          30,
        ),
      );
      expect(advanced.success).toEqual({
        revision: before.revision + 1,
        isNoop: false,
      });
      expect(advanced.frame).toEqual({
        state: {
          ...before,
          liveClipId: clipId,
          clipSequence: before.clipSequence + 1,
          revision: before.revision + 1,
          updatedAt: 30,
        },
        cause: 'shuffle',
        sourceClientId: null,
      });

      expect(
        failureOf(
          service.applyScreenAdvance(
            ADMIN_USER_ID,
            'socket-lead',
            payload,
            true,
            31,
          ),
        ).code,
      ).toBe('vj_stale_clip_sequence');
    });
  });

  describe('status, library, sweep', () => {
    it('stores a screen status and cuts the clip list at 200', () => {
      const screenId = randomUUID();
      const packId = randomUUID();
      attachScreen(service, 'socket-a', screenId, 1);
      const clips = Array.from({ length: 250 }, () => clipStatus());
      clips[0] = clipStatus({
        state: 'failed',
        progress: 0,
        failure: 'network',
      });
      clips[1] = clipStatus({
        state: 'ready',
        progress: 1,
        failure: 'network',
      });

      expect(
        service.updateScreenStatus(
          ADMIN_USER_ID,
          'socket-a',
          { isFullscreen: true, preload: { packId, clips } },
          40,
        ),
      ).toBe(true);
      const screen = itemAt(service.listScreens(ADMIN_USER_ID, 40), 0);
      expect(screen.isFullscreen).toBe(true);
      expect(screen.lastSeenAt).toBe(40);
      expect(screen.preload.packId).toBe(packId);
      expect(screen.preload.clips).toHaveLength(200);
      expect(itemAt(screen.preload.clips, 0).failure).toBe('network');
      expect(itemAt(screen.preload.clips, 1).failure).toBeNull();
      expect(itemAt(screen.preload.clips, 199).clipId).toBe(
        itemAt(clips, 199).clipId,
      );
    });

    it('drops a malformed status', () => {
      attachScreen(service, 'socket-a', randomUUID(), 1);
      const before = service.listScreens(ADMIN_USER_ID, 1);
      const malformedPayloads: Record<string, unknown>[] = [
        {
          isFullscreen: true,
          preload: { packId: null, clips: [clipStatus({ progress: 2 })] },
        },
        {
          isFullscreen: true,
          preload: {
            packId: null,
            clips: [{ ...clipStatus(), state: 'paused' }],
          },
        },
        {
          isFullscreen: true,
          preload: { packId: null, clips: [clipStatus({ clipId: 'clip-1' })] },
        },
        { isFullscreen: 'yes', preload: { packId: null, clips: [] } },
        { isFullscreen: true, preload: { packId: 'pack', clips: [] } },
        { isFullscreen: true, preload: { packId: null, clips: 'all' } },
        { isFullscreen: true },
      ];
      for (const payload of malformedPayloads) {
        expect(
          service.updateScreenStatus(ADMIN_USER_ID, 'socket-a', payload, 50),
        ).toBe(false);
      }
      expect(service.listScreens(ADMIN_USER_ID, 1)).toEqual(before);
      expect(
        service.updateScreenStatus(
          ADMIN_USER_ID,
          'socket-unknown',
          { isFullscreen: true, preload: { packId: null, clips: [] } },
          50,
        ),
      ).toBe(false);
    });

    it('clears a deleted active pack and turns shuffle off', () => {
      const deletedPackId = randomUUID();
      const otherPackId = randomUUID();
      const liveClipId = randomUUID();
      const adminIds = [randomUUID(), randomUUID(), randomUUID()];
      adminIds.forEach((adminUserId, index) => {
        service.attachRemote(adminUserId, `remote-${index}`, 0);
        const remote = createRemote(service, adminUserId);
        remote.send('stage:goClip', { clipId: liveClipId });
        remote.send('stage:setPack', {
          packId: index < 2 ? deletedPackId : otherPackId,
        });
        remote.send('stage:setShuffle', { isOn: true });
      });
      const beforeStates = adminIds.map((adminUserId) =>
        stateOf(service, adminUserId),
      );

      const frames = service.applyLibraryChange(
        {
          kind: 'pack_deleted',
          packId: deletedPackId,
          clipId: null,
          packIds: [deletedPackId],
        },
        70,
      );
      expect(frames.map((entry) => entry.adminUserId)).toEqual(
        adminIds.slice(0, 2),
      );
      frames.forEach((entry, index) => {
        const before = itemAt(beforeStates, index);
        expect(entry.frame).toEqual({
          state: {
            ...before,
            activePackId: null,
            shuffle: { ...before.shuffle, isOn: false },
            clipSequence: before.clipSequence + 1,
            revision: before.revision + 1,
            updatedAt: 70,
          },
          cause: 'library',
          sourceClientId: null,
        });
        expect(entry.frame.state.liveClipId).toBe(liveClipId);
      });
      expect(stateOf(service, itemAt(adminIds, 2))).toEqual(
        itemAt(beforeStates, 2),
      );
    });

    it('sends the stage to black when the live clip is deleted', () => {
      service.attachRemote(ADMIN_USER_ID, 'remote-socket', 0);
      const remote = createRemote(service);
      const liveClipId = randomUUID();
      remote.send('stage:goClip', { clipId: liveClipId });
      const before = stateOf(service);

      const frames = service.applyLibraryChange(
        {
          kind: 'clip_deleted',
          packId: null,
          clipId: liveClipId,
          packIds: [randomUUID()],
        },
        80,
      );
      expect(frames).toHaveLength(1);
      expect(itemAt(frames, 0).frame.state).toMatchObject({
        liveClipId: null,
        clipSequence: before.clipSequence + 1,
        revision: before.revision + 1,
      });
      expect(itemAt(frames, 0).frame.cause).toBe('library');
    });

    it('leaves stages alone for unrelated changes', () => {
      service.attachRemote(ADMIN_USER_ID, 'remote-socket', 0);
      const remote = createRemote(service);
      const packId = randomUUID();
      const clipId = randomUUID();
      remote.send('stage:goClip', { clipId });
      remote.send('stage:setPack', { packId });
      const before = stateOf(service);

      const changes = [
        { kind: 'pack_renamed', packId, clipId: null, packIds: [] },
        { kind: 'pack_clips_changed', packId, clipId, packIds: [packId] },
        { kind: 'clip_updated', packId: null, clipId, packIds: [packId] },
        {
          kind: 'pack_deleted',
          packId: randomUUID(),
          clipId: null,
          packIds: [],
        },
        {
          kind: 'clip_deleted',
          packId: null,
          clipId: randomUUID(),
          packIds: [],
        },
      ] as const;
      for (const change of changes) {
        expect(
          service.applyLibraryChange(
            { ...change, packIds: [...change.packIds] },
            90,
          ),
        ).toEqual([]);
      }
      expect(stateOf(service)).toEqual(before);
    });

    it('evicts a stage idle for six hours and prunes offline screens after ten minutes', () => {
      jest.useFakeTimers();
      const startedAt = 1_000_000;
      jest.setSystemTime(startedAt);
      const sweepAt = startedAt + VJ_STAGE_IDLE_EVICTION_MS + 1;
      const attachedAdmin = randomUUID();
      const idleAdmin = randomUUID();
      const borderAdmin = randomUUID();

      service.attachRemote(attachedAdmin, 'remote-attached', startedAt);
      attachScreen(service, 'screen-socket', randomUUID(), startedAt, {
        adminUserId: attachedAdmin,
      });
      service.detachSocket(attachedAdmin, 'screen-socket', startedAt + 10);

      service.attachRemote(idleAdmin, 'remote-idle', startedAt);
      createRemote(service, idleAdmin).send(
        'stage:setStrobe',
        { isStrobing: true },
        startedAt,
      );
      service.detachSocket(idleAdmin, 'remote-idle', startedAt);

      service.attachRemote(borderAdmin, 'remote-border', startedAt);
      service.detachSocket(borderAdmin, 'remote-border', startedAt + 1);

      const retentionEnd = startedAt + 10 + VJ_SCREEN_OFFLINE_RETENTION_MS;
      expect(service.listScreens(attachedAdmin, retentionEnd)).toEqual([
        expect.objectContaining({ isConnected: false, isLead: false }),
      ]);
      expect(jest.getTimerCount()).toBe(1);

      service.sweep(sweepAt);
      expect(service.getState(attachedAdmin)).not.toBeNull();
      expect(service.listScreens(attachedAdmin, sweepAt)).toEqual([]);
      expect(service.getState(idleAdmin)).toBeNull();
      expect(service.getState(borderAdmin)).not.toBeNull();
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(20_000);
      expect(broadcasts).toHaveLength(0);
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

      const newcomer = attachedOf(
        attachScreen(service, 'socket-c', randomUUID(), 200_000_000),
      );
      expect(newcomer.isLead).toBe(false);
      expect(
        service
          .listScreens(ADMIN_USER_ID, 200_000_000)
          .map((screen) => screen.number),
      ).toEqual([2, 3]);
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
          remote.send('stage:setOverlay', { text: secret, style: 'marquee' }),
        ),
        failureOf(
          remote.send('stage:setOverlay', { text: secret, isVisible: 'yes' }),
        ),
        failureOf(
          service.applyRemoteCommand(
            ADMIN_USER_ID,
            'stage:setOverlay',
            { text: secret, clientId: secret, commandSequence: 1 },
            true,
            0,
          ),
        ),
      ];
      expect(failures.map((failure) => failure.code)).toEqual([
        'vj_overlay_text_invalid',
        'vj_overlay_text_too_long',
        'vj_overlay_style_invalid',
        'vj_effect_flag_invalid',
        'vj_client_id_invalid',
      ]);
      for (const failure of failures) {
        expect(failure.message).not.toContain('SECRET');
        expect(JSON.stringify(failure)).not.toContain('SECRET');
      }
    });
  });
});
