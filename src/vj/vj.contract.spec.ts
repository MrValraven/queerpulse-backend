import {
  VJ_CLIENT_FRAME_NAMES,
  VJ_EXCEPTION_DOMAIN_CODES,
  VJ_LIBRARY_CHANGE_KINDS,
  VJ_LIBRARY_CHANGED,
  VJ_LIMITS,
  VJ_REMOTE_COMMAND_NAMES,
  VJ_SERVER_FRAME_NAMES,
  VJ_SOCKET_ERROR_CODES,
  createVjStageState,
  vjShuffleIntervalMs,
  vjStrobeFlashesPerSecond,
  type VjShuffle,
} from './vj.contract';

function buildShuffle(overrides: Partial<VjShuffle>): VjShuffle {
  return {
    isOn: true,
    intervalKind: 'seconds',
    intervalValue: 8,
    bpm: 124,
    ...overrides,
  };
}

describe('vj contract', () => {
  it('builds the default stage', () => {
    expect(createVjStageState('epoch-1', 1000)).toEqual({
      stageEpoch: 'epoch-1',
      revision: 0,
      clipSequence: 0,
      activePackId: null,
      liveClipId: null,
      transition: { mode: 'fade', fadeMs: 800 },
      overlay: { text: '', style: 'big', isVisible: false },
      effects: {
        speed: 1,
        isMonochrome: false,
        isMirrored: false,
        isHueCycling: false,
        isStrobing: false,
        isBlackout: false,
        strobeStartedAt: null,
      },
      shuffle: {
        isOn: false,
        intervalKind: 'seconds',
        intervalValue: 8,
        bpm: 124,
      },
      updatedAt: 1000,
    });
  });

  it('hands out a fresh object on every call', () => {
    const first = createVjStageState('epoch-1', 1000);
    const second = createVjStageState('epoch-1', 1000);
    first.effects.isBlackout = true;
    expect(second.effects.isBlackout).toBe(false);
  });

  it('computes the shuffle interval in seconds and in beats', () => {
    expect(
      vjShuffleIntervalMs(
        buildShuffle({ intervalKind: 'seconds', intervalValue: 8 }),
      ),
    ).toBe(8000);
    expect(
      vjShuffleIntervalMs(
        buildShuffle({ intervalKind: 'beats', intervalValue: 8, bpm: 124 }),
      ),
    ).toBe(Math.round((8 * 60000) / 124));
    expect(
      vjShuffleIntervalMs(
        buildShuffle({ intervalKind: 'beats', intervalValue: 8, bpm: 124 }),
      ),
    ).toBe(3871);
    expect(
      vjShuffleIntervalMs(
        buildShuffle({ intervalKind: 'beats', intervalValue: 32, bpm: 60 }),
      ),
    ).toBe(32000);
  });

  it('caps the strobe at three flashes per second', () => {
    expect(vjStrobeFlashesPerSecond(60)).toBe(1);
    expect(vjStrobeFlashesPerSecond(124)).toBe(124 / 60);
    expect(vjStrobeFlashesPerSecond(180)).toBe(3);
    expect(vjStrobeFlashesPerSecond(200)).toBe(3);
  });

  it('lists the frames, codes and change kinds of the contract', () => {
    expect(VJ_CLIENT_FRAME_NAMES).toEqual([
      'vj:attach',
      'session:reauth',
      'stage:setPack',
      'stage:goClip',
      'stage:setTransition',
      'stage:setOverlay',
      'stage:setEffects',
      'stage:setStrobe',
      'stage:setShuffle',
      'screen:advance',
      'screen:status',
    ]);
    expect(VJ_SERVER_FRAME_NAMES).toEqual([
      'stage:state',
      'screen:role',
      'screens:update',
      'library:changed',
      'exception',
    ]);
    expect(VJ_REMOTE_COMMAND_NAMES).toEqual([
      'stage:setPack',
      'stage:goClip',
      'stage:setTransition',
      'stage:setOverlay',
      'stage:setEffects',
      'stage:setStrobe',
      'stage:setShuffle',
    ]);
    expect(VJ_EXCEPTION_DOMAIN_CODES).toEqual([
      'vj_not_admin',
      'vj_screen_replaced',
    ]);
    expect(VJ_LIBRARY_CHANGE_KINDS).toEqual([
      'pack_created',
      'pack_renamed',
      'pack_deleted',
      'packs_reordered',
      'pack_clips_changed',
      'clip_created',
      'clip_updated',
      'clip_deleted',
    ]);
    expect(VJ_SOCKET_ERROR_CODES).toHaveLength(27);
    expect(new Set(VJ_SOCKET_ERROR_CODES).size).toBe(27);
    expect(VJ_SOCKET_ERROR_CODES[0]).toBe('vj_not_admin');
    expect(VJ_SOCKET_ERROR_CODES[VJ_SOCKET_ERROR_CODES.length - 1]).toBe(
      'vj_server_error',
    );
    expect(VJ_LIBRARY_CHANGED).toBe('vj.library.changed');
  });

  it('pins the limits', () => {
    expect(VJ_LIMITS).toEqual({
      clipMaxBytes: 104857600,
      thumbnailMaxBytes: 262144,
      thumbnailLongEdgePx: 480,
      clipTitleMax: 120,
      packNameMax: 60,
      packsMax: 50,
      packClipsMax: 200,
      libraryClipsMax: 1000,
      dimensionMax: 16384,
      durationMsMax: 3600000,
      fadeMsMin: 0,
      fadeMsMax: 4000,
      fadeMsDefault: 800,
      overlayTextMax: 80,
      shuffleSecondsMin: 2,
      shuffleSecondsMax: 60,
      shuffleSecondsDefault: 8,
      shuffleBeatsDefault: 8,
      bpmMin: 60,
      bpmMax: 200,
      bpmDefault: 124,
      strobeMaxFlashesPerSecond: 3,
      strobeMaxDurationMs: 10000,
      mediaUrlTtlSeconds: 900,
      mediaClipIdsMax: 200,
    });
  });
});
