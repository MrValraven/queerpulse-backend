import {
  DEFAULT_VJ_STEP_DURATION,
  VJ_CLIENT_FRAME_NAMES,
  VJ_CONTRACT_VERSION,
  VJ_EFFECT_CATALOG,
  VJ_EFFECT_IDS,
  VJ_EXCEPTION_DOMAIN_CODES,
  VJ_GENERATOR_CATALOG,
  VJ_GENERATOR_IDS,
  VJ_LIBRARY_CHANGE_KINDS,
  VJ_LIBRARY_CHANGED,
  VJ_LIMITS,
  VJ_REMOTE_COMMAND_NAMES,
  VJ_RENDER_MODES,
  VJ_RENDERERS,
  VJ_SERVER_FRAME_NAMES,
  VJ_SETLIST_ITEM_KINDS,
  VJ_SETLIST_PLAYBACK_STATUSES,
  VJ_SOCKET_ERROR_CODES,
  VJ_SPEEDS,
  VJ_STAGE_CAUSES,
  VJ_STEP_BEAT_COUNTS,
  VJ_STEP_DURATION_KINDS,
  VJ_TRANSITION_CATALOG,
  VJ_TRANSITION_IDS,
  canonicalVjStageState,
  createVjSetlistPlayback,
  createVjStageState,
  isSameVjStageContent,
  isVjStepDuration,
  restoredVjSetlistPlayback,
  roundVjAmount,
  stampVjSetlistClock,
  upgradeVjStageFieldsV1,
  upgradeVjStageFieldsV2,
  vjBeatPositionAt,
  vjBlackoutFadeMs,
  vjClockOffsetMs,
  vjEffectSettingOf,
  vjIsLiveSourceChange,
  vjIsQuantizedChange,
  vjLastDownbeatAt,
  vjNextBoundaryAt,
  vjQuantizedApplyAt,
  vjResolvedStepDuration,
  vjSceneLookFlashes,
  vjSceneLookOf,
  vjSetlistAdvanceApplyAt,
  vjSetlistClearedState,
  vjSetlistFollowState,
  vjSetlistIndexPosition,
  vjSetlistLoopingState,
  vjSetlistSelectReadPosition,
  vjSetlistSelectTransition,
  vjSetlistSetPlayingReadPosition,
  vjSetlistSetPlayingTransition,
  vjSetlistStepFlashes,
  vjSetlistStepReadPosition,
  vjSetlistStepTransition,
  vjSetlistTakeoverState,
  vjSetlistTimerReadPosition,
  vjSetlistTimerTargetAt,
  vjSetlistTimerTransition,
  vjShuffleIntervalMs,
  vjStepDurationMs,
  vjStrobeFlashesPerSecond,
  vjTransitionLengthMs,
  type VjClockSample,
  type VjEffectId,
  type VjSceneLook,
  type VjSetlistPlayback,
  type VjSetlistRead,
  type VjSetlistReadPosition,
  type VjSetlistRefusalCode,
  type VjSetlistRestoreInput,
  type VjSetlistStepRead,
  type VjSetlistTransition,
  type VjSetlistTransitionResult,
  type VjShuffle,
  type VjStageState,
  type VjStepDuration,
  type VjTempo,
  type VjTransition,
} from './vj.contract';

const NOW = 1_700_000_000_000;
const PACK_ID = '77777777-7777-4777-8777-777777777777';
const OTHER_PACK_ID = '66666666-6666-4666-8666-666666666666';
const CLIP_ID = '88888888-8888-4888-8888-888888888888';
const OTHER_CLIP_ID = '99999999-9999-4999-8999-999999999999';
const SCREEN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SCREEN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function buildTempo(overrides: Partial<VjTempo> = {}): VjTempo {
  return {
    bpm: 120,
    downbeatAt: 10_000,
    quantize: 'off',
    source: 'manual',
    ...overrides,
  };
}

function buildShuffle(overrides: Partial<VjShuffle>): VjShuffle {
  return {
    isOn: true,
    intervalKind: 'seconds',
    intervalValue: 8,
    source: 'pack',
    excludedClipIds: [],
    ...overrides,
  };
}

function buildState(overrides: Partial<VjStageState> = {}): VjStageState {
  return { ...createVjStageState('epoch-1', NOW), ...overrides };
}

function buildV1State(): Record<string, unknown> {
  return {
    stageEpoch: 'epoch-1',
    revision: 4,
    clipSequence: 3,
    activePackId: PACK_ID,
    liveClipId: null,
    transition: { mode: 'cut', fadeMs: 1200 },
    overlay: { text: 'Hello', style: 'ticker', isVisible: true },
    effects: {
      speed: 1.5,
      isMonochrome: false,
      isMirrored: false,
      isHueCycling: false,
      isStrobing: false,
      isBlackout: true,
      strobeStartedAt: null,
    },
    shuffle: {
      isOn: true,
      intervalKind: 'beats',
      intervalValue: 16,
      bpm: 128.5,
    },
    updatedAt: 5000,
  };
}

describe('vj contract', () => {
  it('names contract version 2', () => {
    expect(VJ_CONTRACT_VERSION).toBe(2);
  });

  it('builds the v2 default stage', () => {
    expect(createVjStageState('epoch-1', 1000)).toEqual({
      stageEpoch: 'epoch-1',
      revision: 0,
      clipSequence: 0,
      activePackId: null,
      liveClipId: null,
      liveGeneratorId: null,
      liveGeneratorVariant: null,
      liveSince: null,
      transition: { mode: 'fade', length: { unit: 'ms', value: 800 } },
      overlay: {
        text: '',
        style: 'big',
        isVisible: false,
        position: 'center',
        size: 'l',
        colorToken: 'cream',
        hideAt: null,
      },
      countdown: { isVisible: false, targetAt: null, label: '' },
      logo: { isVisible: false, corner: 'bottomRight' },
      eventCard: { isVisible: false, kind: 'qr' },
      effects: {
        speed: 1,
        settings: {},
        isStrobing: false,
        isBlackout: false,
        strobeStartedAt: null,
      },
      mix: { clipId: null, amount: 0, blendMode: 'normal' },
      tempo: {
        bpm: 124,
        downbeatAt: 1000,
        quantize: 'off',
        source: 'manual',
      },
      shuffle: {
        isOn: false,
        intervalKind: 'seconds',
        intervalValue: 8,
        source: 'pack',
        excludedClipIds: [],
      },
      recentClipIds: [],
      screenOverrides: {},
      activeSetlistId: null,
      setlistIndex: null,
      setlistPlayback: {
        status: 'manual',
        itemId: null,
        isFlashConfirmed: false,
        stepStartedAt: null,
        stepEndsAt: null,
        stepDurationMs: null,
        pausedRemainingMs: null,
        isLooping: false,
      },
      updatedAt: 1000,
    });
  });

  it('hands out a fresh object on every call', () => {
    const first = createVjStageState('epoch-1', 1000);
    const second = createVjStageState('epoch-1', 1000);
    first.effects.isBlackout = true;
    first.shuffle.excludedClipIds.push(CLIP_ID);
    expect(second.effects.isBlackout).toBe(false);
    expect(second.shuffle.excludedClipIds).toEqual([]);
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
      previewMaxBytes: 524288,
      previewLongEdgePx: 240,
      previewDurationMs: 2000,
      loopMinLengthMs: 250,
      amountStep: 0.01,
      effectsOnMax: 8,
      overlayHideAfterMsMin: 1000,
      overlayHideAfterMsMax: 600000,
      countdownLabelMax: 40,
      countdownLeadMsMin: 1000,
      countdownLeadMsMax: 86400000,
      countdownHoldMs: 10000,
      recentClipsMax: 8,
      excludedClipIdsMax: 200,
      screenOverridesMax: 16,
      identifyDurationMs: 3000,
      sceneNameMax: 60,
      scenesMax: 200,
      sceneLookMaxBytes: 16384,
      setlistNameMax: 60,
      setlistsMax: 50,
      setlistItemsMax: 100,
      setlistStepSecondsMin: 2,
      setlistStepSecondsMax: 600,
      setlistStepSecondsDefault: 8,
      setlistTimerRetryMs: 1000,
      downbeatSkewMsMax: 60000,
      quantizeMinLeadMs: 150,
      quantizedAdvanceEarlyMs: 300,
      micConfidenceMin: 0.6,
      micTempoMinIntervalMs: 2000,
      micBpmDeltaMin: 0.5,
      micPhaseDriftMsMin: 40,
      upcomingEventsMax: 50,
    });
  });

  it('widens the speeds and lists the v2 causes', () => {
    expect(VJ_SPEEDS).toEqual([0.25, 0.5, 1, 1.5, 2, 4]);
    expect(VJ_STAGE_CAUSES).toEqual([
      'attach',
      'restore',
      'command',
      'shuffle',
      'strobe_timeout',
      'library',
      'mic_tempo',
      'overlay_timeout',
      'countdown_end',
      'setlist',
    ]);
  });

  it('lists the catalog in catalog order with a catalog entry per id', () => {
    expect(Object.keys(VJ_EFFECT_CATALOG)).toEqual([...VJ_EFFECT_IDS]);
    expect(VJ_EFFECT_IDS).toHaveLength(34);
    // Tint opens on the coral accent and kaleidoscope on six segments; every
    // other variant effect opens on its first variant.
    const pinnedDefaultVariants: Partial<Record<VjEffectId, string>> = {
      tint: 'coral',
      kaleidoscope: '6',
    };
    for (const effectId of VJ_EFFECT_IDS) {
      const entry = VJ_EFFECT_CATALOG[effectId];
      const expectedDefaultVariant =
        entry.variants.length === 0
          ? null
          : (pinnedDefaultVariants[effectId] ?? entry.variants[0]);
      expect(entry.defaultVariant).toBe(expectedDefaultVariant);
      if (entry.variants.length > 0) {
        expect(entry.variants).toContain(entry.defaultVariant);
      }
      expect(Math.round(entry.defaultAmount * 100) / 100).toBe(
        entry.defaultAmount,
      );
      expect(entry.defaultAmount).toBeGreaterThanOrEqual(0);
      expect(entry.defaultAmount).toBeLessThanOrEqual(1);
    }
    const playheadIds = VJ_EFFECT_IDS.filter(
      (effectId) => VJ_EFFECT_CATALOG[effectId].exclusiveGroup === 'playhead',
    );
    expect(playheadIds).toEqual(['freeze', 'reverse', 'pingPong']);
    expect(Object.keys(VJ_GENERATOR_CATALOG)).toEqual([...VJ_GENERATOR_IDS]);
    expect(Object.keys(VJ_TRANSITION_CATALOG)).toEqual([...VJ_TRANSITION_IDS]);
  });

  it('pins every catalog flag and default amount to the contract 3.2 rows', () => {
    // [id, isFlashCapable, isDomCapable, isBeatSynced, isAudioReactive,
    //  isAmountAdjustable, defaultAmount]; flash safety reads these flags.
    const contractRows: [
      VjEffectId,
      boolean,
      boolean,
      boolean,
      boolean,
      boolean,
      number,
    ][] = [
      ['monochrome', false, true, false, false, true, 1],
      ['invert', true, true, true, false, true, 1],
      ['saturate', false, true, false, false, true, 0.5],
      ['contrast', false, true, false, false, true, 0.5],
      ['tint', false, true, false, false, true, 0.5],
      ['duotone', false, true, false, false, true, 1],
      ['prideGrade', false, false, false, false, true, 0.6],
      ['thermal', false, false, false, false, true, 1],
      ['hueCycle', false, true, false, false, true, 0.5],
      ['hueShift', false, true, false, false, true, 0.5],
      ['vhs', false, false, false, false, true, 0.6],
      ['filmGrain', false, false, false, false, true, 0.4],
      ['scanlines', false, true, false, false, true, 0.5],
      ['crt', false, false, false, false, true, 0.6],
      ['rgbSplit', false, false, true, true, true, 0.4],
      ['pixelate', false, false, false, false, true, 0.5],
      ['halftone', false, false, false, false, true, 0.5],
      ['glitch', true, false, true, true, true, 0.4],
      ['dream', false, true, false, false, true, 0.5],
      ['vignette', false, true, false, false, true, 0.5],
      ['lightLeaks', false, false, false, false, true, 0.5],
      ['mirror', false, true, false, false, false, 1],
      ['kaleidoscope', false, false, false, false, true, 0.5],
      ['tile', false, false, false, false, false, 1],
      ['kenBurns', false, true, false, false, true, 0.5],
      ['rotate', false, true, false, false, true, 0.25],
      ['zoomPulse', false, true, true, true, true, 0.5],
      ['mask', false, true, false, false, true, 0.8],
      ['freeze', false, true, false, false, false, 1],
      ['reverse', false, false, false, false, false, 1],
      ['pingPong', false, false, false, false, false, 1],
      ['stutter', false, false, true, false, true, 0.5],
      ['echo', false, false, false, false, true, 0.5],
      ['beatPulse', true, true, true, true, true, 0.5],
    ];
    expect(contractRows.map(([effectId]) => effectId)).toEqual([
      ...VJ_EFFECT_IDS,
    ]);
    for (const [
      effectId,
      isFlashCapable,
      isDomCapable,
      isBeatSynced,
      isAudioReactive,
      isAmountAdjustable,
      defaultAmount,
    ] of contractRows) {
      const entry = VJ_EFFECT_CATALOG[effectId];
      expect({
        effectId,
        isFlashCapable: entry.isFlashCapable,
        isDomCapable: entry.isDomCapable,
        isBeatSynced: entry.isBeatSynced,
        isAudioReactive: entry.isAudioReactive,
        isAmountAdjustable: entry.isAmountAdjustable,
        defaultAmount: entry.defaultAmount,
      }).toEqual({
        effectId,
        isFlashCapable,
        isDomCapable,
        isBeatSynced,
        isAudioReactive,
        isAmountAdjustable,
        defaultAmount,
      });
    }
  });

  it('reads an effect setting or its off default and rounds amounts', () => {
    const effects = createVjStageState('epoch-1', NOW).effects;
    expect(vjEffectSettingOf(effects, 'tint')).toEqual({
      isOn: false,
      amount: 0.5,
      variant: 'coral',
    });
    effects.settings.tint = { isOn: true, amount: 0.7, variant: 'jade' };
    expect(vjEffectSettingOf(effects, 'tint')).toEqual({
      isOn: true,
      amount: 0.7,
      variant: 'jade',
    });
    expect(roundVjAmount(0.123)).toBe(0.12);
    expect(roundVjAmount(0.125)).toBe(0.13);
  });

  it('finds beat positions before and after the downbeat', () => {
    const tempo = buildTempo();
    expect(vjBeatPositionAt(tempo, 10_000)).toEqual({
      beatIndex: 0,
      barIndex: 0,
      beatInBar: 0,
      phase: 0,
    });
    expect(vjBeatPositionAt(tempo, 9750)).toEqual({
      beatIndex: -1,
      barIndex: -1,
      beatInBar: 3,
      phase: 0.5,
    });
    const afterOneBar = vjBeatPositionAt(tempo, 12_000);
    expect(afterOneBar.barIndex).toBe(1);
    expect(afterOneBar.beatInBar).toBe(0);
    expect(afterOneBar.beatIndex).toBe(4);
  });

  it('lands vjNextBoundaryAt on an exact boundary and ahead of it', () => {
    const tempo = buildTempo();
    expect(vjNextBoundaryAt(tempo, 'beat', 10_500)).toBe(10_500);
    expect(vjNextBoundaryAt(tempo, 'beat', 10_501)).toBe(11_000);
    expect(vjNextBoundaryAt(tempo, 'bar', 10_001)).toBe(12_000);
    expect(vjNextBoundaryAt(tempo, 'bar', 12_000)).toBe(12_000);
    expect(vjNextBoundaryAt(tempo, 'beat', 8_800)).toBe(9_000);
    expect(vjNextBoundaryAt(tempo, 'bar', 7_000)).toBe(8_000);
  });

  it('answers the last downbeat at or before a time', () => {
    const tempo = buildTempo();
    expect(vjLastDownbeatAt(tempo, 10_000)).toBe(10_000);
    expect(vjLastDownbeatAt(tempo, 11_999)).toBe(10_000);
    expect(vjLastDownbeatAt(tempo, 12_000)).toBe(12_000);
    expect(vjLastDownbeatAt(tempo, 9_999)).toBe(8_000);
  });

  it('answers a 124 BPM boundary with itself when fed back', () => {
    const tempo = buildTempo({ bpm: 124, downbeatAt: 0 });
    expect(vjNextBoundaryAt(tempo, 'bar', 1)).toBe(1935);
    expect(vjNextBoundaryAt(tempo, 'bar', 3871)).toBe(3871);
    expect(vjNextBoundaryAt(tempo, 'bar', 3872)).toBe(5806);
    expect(vjNextBoundaryAt(tempo, 'beat', 1935)).toBe(1935);
    let earliestBar = 1;
    let earliestBeat = 1;
    for (let step = 0; step < 16; step += 1) {
      const bar = vjNextBoundaryAt(tempo, 'bar', earliestBar);
      expect(vjNextBoundaryAt(tempo, 'bar', bar)).toBe(bar);
      const beat = vjNextBoundaryAt(tempo, 'beat', earliestBeat);
      expect(vjNextBoundaryAt(tempo, 'beat', beat)).toBe(beat);
      earliestBar = bar + 1;
      earliestBeat = beat + 1;
    }
  });

  it('answers a 124 BPM bar boundary as its own last downbeat', () => {
    const tempo = buildTempo({ bpm: 124, downbeatAt: 0 });
    expect(vjLastDownbeatAt(tempo, 1935)).toBe(1935);
    expect(vjLastDownbeatAt(tempo, 1934)).toBe(0);
    expect(vjLastDownbeatAt(tempo, 3871)).toBe(3871);
    let earliestBar = 1;
    for (let step = 0; step < 16; step += 1) {
      const bar = vjNextBoundaryAt(tempo, 'bar', earliestBar);
      expect(vjLastDownbeatAt(tempo, bar)).toBe(bar);
      earliestBar = bar + 1;
    }
  });

  it('reads beat 0 of a bar on a 124 BPM bar boundary', () => {
    const tempo = buildTempo({ bpm: 124, downbeatAt: 0 });
    expect(vjBeatPositionAt(tempo, 1935)).toEqual({
      beatIndex: 4,
      barIndex: 1,
      beatInBar: 0,
      phase: 0,
    });
    let earliestBar = 1;
    for (let step = 1; step <= 16; step += 1) {
      const bar = vjNextBoundaryAt(tempo, 'bar', earliestBar);
      const position = vjBeatPositionAt(tempo, bar);
      expect(position.barIndex).toBe(step);
      expect(position.beatInBar).toBe(0);
      expect(position.phase).toBeGreaterThanOrEqual(0);
      expect(position.phase).toBeLessThan(0.01);
      earliestBar = bar + 1;
    }
  });

  it('quantizes with the 150 ms lead and answers null when off', () => {
    expect(vjQuantizedApplyAt(buildTempo(), 10_000)).toBeNull();
    expect(vjQuantizedApplyAt(buildTempo({ quantize: 'beat' }), 10_000)).toBe(
      10_500,
    );
    expect(vjQuantizedApplyAt(buildTempo({ quantize: 'beat' }), 10_350)).toBe(
      10_500,
    );
    expect(vjQuantizedApplyAt(buildTempo({ quantize: 'beat' }), 10_351)).toBe(
      11_000,
    );
    expect(vjQuantizedApplyAt(buildTempo({ quantize: 'bar' }), 10_000)).toBe(
      12_000,
    );
  });

  it('measures transitions and blackout fades', () => {
    const tempo = buildTempo();
    const cut: VjTransition = {
      mode: 'cut',
      length: { unit: 'ms', value: 900 },
    };
    expect(vjTransitionLengthMs(cut, tempo)).toBe(0);
    const inMs: VjTransition = {
      mode: 'fade',
      length: { unit: 'ms', value: 900 },
    };
    expect(vjTransitionLengthMs(inMs, tempo)).toBe(900);
    const inBeats: VjTransition = {
      mode: 'iris',
      length: { unit: 'beats', value: 4 },
    };
    expect(vjTransitionLengthMs(inBeats, tempo)).toBe(2000);
    const longBeats: VjTransition = {
      mode: 'fade',
      length: { unit: 'beats', value: 16 },
    };
    const slowTempo = buildTempo({ bpm: 60 });
    expect(vjTransitionLengthMs(longBeats, slowTempo)).toBe(16_000);
    expect(vjBlackoutFadeMs(longBeats, slowTempo)).toBe(4000);
  });

  it('computes the shuffle interval from tempo.bpm', () => {
    expect(
      vjShuffleIntervalMs(
        buildShuffle({ intervalKind: 'seconds', intervalValue: 8 }),
        buildTempo({ bpm: 124 }),
      ),
    ).toBe(8000);
    expect(
      vjShuffleIntervalMs(
        buildShuffle({ intervalKind: 'beats', intervalValue: 8 }),
        buildTempo({ bpm: 124 }),
      ),
    ).toBe(3871);
    expect(
      vjShuffleIntervalMs(
        buildShuffle({ intervalKind: 'beats', intervalValue: 32 }),
        buildTempo({ bpm: 60 }),
      ),
    ).toBe(32000);
  });

  it('caps the strobe at three flashes per second', () => {
    expect(vjStrobeFlashesPerSecond(60)).toBe(1);
    expect(vjStrobeFlashesPerSecond(124)).toBe(124 / 60);
    expect(vjStrobeFlashesPerSecond(180)).toBe(3);
    expect(vjStrobeFlashesPerSecond(200)).toBe(3);
  });

  it('flags exactly the quantized changes', () => {
    const previous = buildState({
      activePackId: PACK_ID,
      liveClipId: CLIP_ID,
      clipSequence: 2,
    });
    const quantizedChanges: VjStageState[] = [
      { ...previous, liveClipId: OTHER_CLIP_ID, clipSequence: 3 },
      {
        ...previous,
        liveClipId: null,
        liveGeneratorId: 'plasma',
        clipSequence: 3,
      },
      {
        ...previous,
        liveClipId: null,
        liveGeneratorId: 'prideFlagWave',
        liveGeneratorVariant: 'trans',
        clipSequence: 3,
      },
      { ...previous, clipSequence: 3 },
      { ...previous, mix: { ...previous.mix, clipId: OTHER_CLIP_ID } },
      { ...previous, overlay: { ...previous.overlay, isVisible: true } },
      {
        ...previous,
        screenOverrides: {
          [SCREEN_ID]: {
            clipId: OTHER_CLIP_ID,
            generatorId: null,
            generatorVariant: null,
          },
        },
      },
    ];
    for (const next of quantizedChanges) {
      expect(vjIsQuantizedChange(previous, next)).toBe(true);
    }
    const generatorPrevious = buildState({
      liveGeneratorId: 'prideFlagWave',
      liveGeneratorVariant: 'rainbow',
    });
    expect(
      vjIsQuantizedChange(generatorPrevious, {
        ...generatorPrevious,
        liveGeneratorVariant: 'bi',
      }),
    ).toBe(true);
    const immediateChanges: VjStageState[] = [
      { ...previous, activePackId: OTHER_PACK_ID, clipSequence: 3 },
      {
        ...previous,
        effects: {
          ...previous.effects,
          settings: { glitch: { isOn: true, amount: 0.7, variant: null } },
        },
      },
      { ...previous, effects: { ...previous.effects, speed: 2 } },
      { ...previous, mix: { ...previous.mix, amount: 0.4 } },
    ];
    for (const next of immediateChanges) {
      expect(vjIsQuantizedChange(previous, next)).toBe(false);
    }
  });

  it('keeps the canonical form', () => {
    const state = buildState({
      activePackId: PACK_ID.toUpperCase(),
      liveClipId: CLIP_ID.toUpperCase(),
      effects: {
        speed: 1,
        settings: {
          vhs: { isOn: true, amount: 0.6, variant: null },
          monochrome: { isOn: true, amount: 1, variant: null },
          tint: { isOn: false, amount: 0.5, variant: 'coral' },
        },
        isStrobing: false,
        isBlackout: false,
        strobeStartedAt: null,
      },
      shuffle: {
        isOn: true,
        intervalKind: 'seconds',
        intervalValue: 8,
        source: 'pack',
        excludedClipIds: [OTHER_CLIP_ID, CLIP_ID.toUpperCase(), CLIP_ID],
      },
      screenOverrides: {
        [OTHER_SCREEN_ID.toUpperCase()]: {
          clipId: null,
          generatorId: 'plasma',
          generatorVariant: null,
        },
        [SCREEN_ID]: {
          clipId: CLIP_ID.toUpperCase(),
          generatorId: null,
          generatorVariant: null,
        },
      },
    });
    const canonical = canonicalVjStageState(state);
    expect(Object.keys(canonical.effects.settings)).toEqual([
      'monochrome',
      'vhs',
    ]);
    expect(Object.keys(canonical.screenOverrides)).toEqual([
      SCREEN_ID,
      OTHER_SCREEN_ID,
    ]);
    expect(canonical.screenOverrides[SCREEN_ID]?.clipId).toBe(CLIP_ID);
    expect(canonical.shuffle.excludedClipIds).toEqual([CLIP_ID, OTHER_CLIP_ID]);
    expect(canonical.activePackId).toBe(PACK_ID);
    expect(canonical.liveClipId).toBe(CLIP_ID);
    expect(Object.keys(canonical)).toEqual(
      Object.keys(createVjStageState('epoch-1', NOW)),
    );

    const reordered: VjStageState = {
      ...state,
      overlay: {
        hideAt: null,
        colorToken: 'cream',
        size: 'l',
        position: 'center',
        isVisible: false,
        style: 'big',
        text: '',
      },
      revision: 9,
      updatedAt: NOW + 5000,
    };
    expect(isSameVjStageContent(state, reordered)).toBe(true);
    const otherAmount: VjStageState = {
      ...state,
      effects: {
        ...state.effects,
        settings: {
          ...state.effects.settings,
          vhs: { isOn: true, amount: 0.61, variant: null },
        },
      },
    };
    expect(isSameVjStageContent(state, otherAmount)).toBe(false);
  });

  it('lowercases the epoch, mix clip, set list and recent clip ids in the canonical form', () => {
    const stageEpoch = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const setlistId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const state = buildState({
      stageEpoch: 'CcCcCcCc-CCCC-4ccc-8CCC-cccccccccccc',
      mix: { clipId: CLIP_ID.toUpperCase(), amount: 0.5, blendMode: 'normal' },
      activeSetlistId: 'DDDDDDDD-dddd-4DDD-8ddd-DDDDDDDDDDDD',
      setlistIndex: 0,
      recentClipIds: [OTHER_CLIP_ID.toUpperCase(), CLIP_ID],
    });
    const canonical = canonicalVjStageState(state);
    expect(canonical.stageEpoch).toBe(stageEpoch);
    expect(canonical.mix.clipId).toBe(CLIP_ID);
    expect(canonical.activeSetlistId).toBe(setlistId);
    expect(canonical.recentClipIds).toEqual([OTHER_CLIP_ID, CLIP_ID]);
    const lowercased = buildState({
      stageEpoch,
      mix: { clipId: CLIP_ID, amount: 0.5, blendMode: 'normal' },
      activeSetlistId: setlistId,
      setlistIndex: 0,
      recentClipIds: [OTHER_CLIP_ID, CLIP_ID],
    });
    expect(isSameVjStageContent(state, lowercased)).toBe(true);
  });

  it('measures the clock offset as the median of the five fastest samples', () => {
    const sample = (roundTripMs: number, offsetMs: number): VjClockSample => ({
      sentAt: 1000,
      receivedAt: 1000 + roundTripMs,
      serverNow: 1000 + roundTripMs / 2 + offsetMs,
    });
    const nineSamples = [
      sample(1200, -999),
      sample(40, 10),
      sample(50, 20),
      sample(60, 30),
      sample(70, 40),
      sample(80, 50),
      sample(300, 500),
      sample(400, 600),
      sample(500, 700),
    ];
    expect(vjClockOffsetMs(nineSamples)).toBe(30);
    expect(
      vjClockOffsetMs([
        sample(40, 10),
        sample(50, 20),
        sample(60, 30),
        sample(70, 40),
      ]),
    ).toBe(25);
    const olderThanKept = [sample(10, 9999), ...nineSamples];
    expect(vjClockOffsetMs(olderThanKept)).toBe(30);
    expect(vjClockOffsetMs([])).toBeNull();
    expect(vjClockOffsetMs([sample(1200, 5)])).toBeNull();
    expect(
      vjClockOffsetMs([{ sentAt: 2000, receivedAt: 1000, serverNow: 0 }]),
    ).toBeNull();
  });

  it('keeps a round trip of exactly 1000 ms and drops 1001 ms', () => {
    const sample = (roundTripMs: number, offsetMs: number): VjClockSample => ({
      sentAt: 1000,
      receivedAt: 1000 + roundTripMs,
      serverNow: 1000 + roundTripMs / 2 + offsetMs,
    });
    expect(vjClockOffsetMs([sample(1000, 7)])).toBe(7);
    expect(vjClockOffsetMs([sample(1001, 7)])).toBeNull();
    expect(vjClockOffsetMs([sample(1001, 999), sample(1000, 7)])).toBe(7);
  });

  it('drops an over-limit sample that would otherwise rank among the five fastest', () => {
    const sample = (roundTripMs: number, offsetMs: number): VjClockSample => ({
      sentAt: 1000,
      receivedAt: 1000 + roundTripMs,
      serverNow: 1000 + roundTripMs / 2 + offsetMs,
    });
    // Five unusable samples leave four usable ones, so the 1001 ms sample
    // would be the fifth fastest; with it the median reads 30, without it 25.
    const nineSamples = [
      sample(100, 10),
      sample(-5, 999),
      sample(200, 20),
      sample(1001, 999),
      sample(-10, 999),
      sample(300, 30),
      { sentAt: 1000, receivedAt: Number.NaN, serverNow: 0 },
      sample(-20, 999),
      sample(400, 40),
    ];
    expect(vjClockOffsetMs(nineSamples)).toBe(25);
  });

  it('upgrades a v1 state and leaves a v2 state alone', () => {
    const upgraded = upgradeVjStageFieldsV1(buildV1State(), NOW);
    expect(upgraded.transition).toEqual({
      mode: 'cut',
      length: { unit: 'ms', value: 1200 },
    });
    expect(upgraded.overlay).toEqual({
      text: 'Hello',
      style: 'ticker',
      isVisible: true,
      position: 'bottom',
      size: 'l',
      colorToken: 'cream',
      hideAt: null,
    });
    expect(upgraded.effects).toEqual({
      speed: 1.5,
      settings: {},
      isStrobing: false,
      isBlackout: true,
      strobeStartedAt: null,
    });
    expect(upgraded.shuffle).toEqual({
      isOn: true,
      intervalKind: 'beats',
      intervalValue: 16,
      source: 'pack',
      excludedClipIds: [],
    });
    expect(upgraded.tempo).toEqual({
      bpm: 128.5,
      downbeatAt: NOW,
      quantize: 'off',
      source: 'manual',
    });
    expect(upgraded.liveSince).toBeNull();
    expect(upgraded.liveGeneratorId).toBeNull();
    expect(upgraded.liveGeneratorVariant).toBeNull();
    expect(upgraded.countdown).toEqual({
      isVisible: false,
      targetAt: null,
      label: '',
    });
    expect(upgraded.logo).toEqual({ isVisible: false, corner: 'bottomRight' });
    expect(upgraded.eventCard).toEqual({ isVisible: false, kind: 'qr' });
    expect(upgraded.mix).toEqual({
      clipId: null,
      amount: 0,
      blendMode: 'normal',
    });
    expect(upgraded.recentClipIds).toEqual([]);
    expect(upgraded.screenOverrides).toEqual({});
    expect(upgraded.activeSetlistId).toBeNull();
    expect(upgraded.setlistIndex).toBeNull();
    expect(upgraded.revision).toBe(4);
    expect(upgraded.clipSequence).toBe(3);

    const withFlags = buildV1State();
    withFlags.liveClipId = CLIP_ID;
    withFlags.overlay = { text: 'Hello', style: 'big', isVisible: false };
    withFlags.effects = {
      speed: 1,
      isMonochrome: true,
      isMirrored: true,
      isHueCycling: true,
      isStrobing: false,
      isBlackout: false,
      strobeStartedAt: null,
    };
    const upgradedFlags = upgradeVjStageFieldsV1(withFlags, NOW);
    expect(upgradedFlags.liveSince).toBe(NOW);
    expect((upgradedFlags.overlay as { position: string }).position).toBe(
      'center',
    );
    expect(upgradedFlags.effects).toEqual({
      speed: 1,
      settings: {
        monochrome: { isOn: true, amount: 1, variant: null },
        hueCycle: { isOn: true, amount: 0.5, variant: null },
        mirror: { isOn: true, amount: 1, variant: 'horizontal' },
      },
      isStrobing: false,
      isBlackout: false,
      strobeStartedAt: null,
    });

    const v2State = buildState({ liveClipId: CLIP_ID, liveSince: NOW - 10 });
    const v2Record = JSON.parse(JSON.stringify(v2State)) as Record<
      string,
      unknown
    >;
    expect(upgradeVjStageFieldsV1(v2Record, NOW)).toEqual(v2State);
    const {
      liveSince: _liveSince,
      recentClipIds: _recentClipIds,
      screenOverrides: _screenOverrides,
      clipSequence: _clipSequence,
      updatedAt: _updatedAt,
      ...v2Restore
    } = v2State;
    expect(
      upgradeVjStageFieldsV1(v2Restore as Record<string, unknown>, NOW),
    ).toEqual(v2Restore);
  });

  it('a non-finite v1 bpm seeds 124', () => {
    for (const bpm of [Number.NaN, Number.POSITIVE_INFINITY, null, '128']) {
      const v1State = buildV1State();
      v1State.shuffle = {
        isOn: true,
        intervalKind: 'beats',
        intervalValue: 16,
        bpm,
      };
      const upgraded = upgradeVjStageFieldsV1(v1State, NOW);
      expect(upgraded.tempo).toEqual({
        bpm: VJ_LIMITS.bpmDefault,
        downbeatAt: NOW,
        quantize: 'off',
        source: 'manual',
      });
      expect(VJ_LIMITS.bpmDefault).toBe(124);
    }
  });

  it('reads a scene look from the stage', () => {
    const withClip = buildState({
      liveClipId: CLIP_ID,
      overlay: {
        text: 'Peak',
        style: 'neon',
        isVisible: true,
        position: 'top',
        size: 'xl',
        colorToken: 'coral',
        hideAt: NOW + 5000,
      },
      mix: { clipId: OTHER_CLIP_ID, amount: 0.4, blendMode: 'screen' },
    });
    const look = vjSceneLookOf(withClip);
    expect(look.source).toEqual({ kind: 'clip', clipId: CLIP_ID });
    expect(look.overlay).toEqual({
      text: 'Peak',
      style: 'neon',
      isVisible: true,
      position: 'top',
      size: 'xl',
      colorToken: 'coral',
    });
    expect(look.overlay).not.toHaveProperty('hideAt');
    expect(look.mix).toEqual({
      clipId: OTHER_CLIP_ID,
      amount: 0.4,
      blendMode: 'screen',
    });
    expect(Object.keys(look)).toEqual([
      'source',
      'effects',
      'transition',
      'overlay',
      'mix',
    ]);
    expect(
      vjSceneLookOf(
        buildState({
          liveGeneratorId: 'prideFlagWave',
          liveGeneratorVariant: 'trans',
        }),
      ).source,
    ).toEqual({
      kind: 'generator',
      generatorId: 'prideFlagWave',
      generatorVariant: 'trans',
    });
    expect(vjSceneLookOf(buildState()).source).toBeNull();
  });

  it('lists the frames, codes and change kinds of the contract', () => {
    expect(VJ_CLIENT_FRAME_NAMES).toEqual([
      'vj:attach',
      'clock:sync',
      'session:reauth',
      'stage:setPack',
      'stage:goClip',
      'stage:goGenerator',
      'stage:setTransition',
      'stage:setOverlay',
      'stage:setEffects',
      'stage:setStrobe',
      'stage:setShuffle',
      'stage:setTempo',
      'stage:setMix',
      'stage:swapMix',
      'stage:setScreenOverride',
      'stage:resetLook',
      'stage:recallScene',
      'stage:setlistSelect',
      'stage:setlistNext',
      'stage:setlistPrevious',
      'stage:setlistSetPlaying',
      'stage:setlistSetLooping',
      'stage:setCountdown',
      'stage:setLogo',
      'stage:setEventCard',
      'screen:identify',
      'screens:setRenderMode',
      'screen:advance',
      'screen:status',
    ]);
    expect(VJ_SERVER_FRAME_NAMES).toEqual([
      'stage:state',
      'screen:role',
      'screens:update',
      'library:changed',
      'screen:identify',
      'screen:renderMode',
      'exception',
    ]);
    expect(VJ_REMOTE_COMMAND_NAMES).toEqual([
      'stage:setPack',
      'stage:goClip',
      'stage:goGenerator',
      'stage:setTransition',
      'stage:setOverlay',
      'stage:setEffects',
      'stage:setStrobe',
      'stage:setShuffle',
      'stage:setTempo',
      'stage:setMix',
      'stage:swapMix',
      'stage:setScreenOverride',
      'stage:resetLook',
      'stage:recallScene',
      'stage:setlistSelect',
      'stage:setlistNext',
      'stage:setlistPrevious',
      'stage:setlistSetPlaying',
      'stage:setlistSetLooping',
      'stage:setCountdown',
      'stage:setLogo',
      'stage:setEventCard',
    ]);
    expect(VJ_EXCEPTION_DOMAIN_CODES).toEqual([
      'vj_not_admin',
      'vj_screen_replaced',
      'vj_stopped',
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
      'clip_favorite_changed',
      'clip_defaults_changed',
      'clip_preview_changed',
      'pack_event_changed',
      'scene_created',
      'scene_updated',
      'scene_deleted',
      'scenes_reordered',
      'setlist_created',
      'setlist_updated',
      'setlist_items_changed',
      'setlist_deleted',
      'setlists_reordered',
    ]);
    expect(VJ_SOCKET_ERROR_CODES).toHaveLength(76);
    expect(new Set(VJ_SOCKET_ERROR_CODES).size).toBe(76);
    expect(VJ_SOCKET_ERROR_CODES[0]).toBe('vj_not_admin');
    expect(VJ_SOCKET_ERROR_CODES[VJ_SOCKET_ERROR_CODES.length - 1]).toBe(
      'vj_setlist_flash_unconfirmed',
    );
    expect(VJ_SOCKET_ERROR_CODES[VJ_SOCKET_ERROR_CODES.length - 2]).toBe(
      'vj_no_screens_connected',
    );
    expect(VJ_SOCKET_ERROR_CODES[VJ_SOCKET_ERROR_CODES.length - 3]).toBe(
      'vj_render_mode_invalid',
    );
    expect(VJ_SOCKET_ERROR_CODES[VJ_SOCKET_ERROR_CODES.length - 4]).toBe(
      'vj_stopped',
    );
    const bpmIndex = VJ_SOCKET_ERROR_CODES.indexOf('vj_bpm_out_of_range');
    expect(VJ_SOCKET_ERROR_CODES[bpmIndex + 1]).toBe('vj_client_outdated');
    expect(VJ_SOCKET_ERROR_CODES[VJ_SOCKET_ERROR_CODES.length - 5]).toBe(
      'vj_server_error',
    );
    expect(VJ_SOCKET_ERROR_CODES[VJ_SOCKET_ERROR_CODES.length - 6]).toBe(
      'vj_event_card_no_event',
    );
    expect(VJ_LIBRARY_CHANGED).toBe('vj.library.changed');
  });

  it('lists the simple renderer and the render modes', () => {
    expect(VJ_RENDERERS).toEqual(['webgl2', 'dom', 'simple']);
    expect(VJ_RENDER_MODES).toEqual(['effects', 'simple']);
  });
});

const SETLIST_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SETLIST_ID = '22222222-2222-4222-8222-222222222222';
const SCENE_ID = '33333333-3333-4333-8333-333333333333';
const ITEM_A = 'a0000000-0000-4000-8000-00000000000a';
const ITEM_B = 'b0000000-0000-4000-8000-00000000000b';
const ITEM_C = 'c0000000-0000-4000-8000-00000000000c';
const ITEM_D = 'd0000000-0000-4000-8000-00000000000d';
const ITEM_X = 'e0000000-0000-4000-8000-00000000000e';
const ITEM_IDS = [ITEM_A, ITEM_B, ITEM_C, ITEM_D];
const EIGHT_SECONDS: VjStepDuration = { kind: 'seconds', value: 8 };

type VjSceneStepRead = Extract<VjSetlistStepRead, { kind: 'scene' }>;
type VjClipStepRead = Extract<VjSetlistStepRead, { kind: 'clip' }>;

function buildLook(isFlashing = false): VjSceneLook {
  const look = vjSceneLookOf(buildState());
  if (!isFlashing) {
    return look;
  }
  return {
    ...look,
    transition: { mode: 'dipWhite', length: { unit: 'ms', value: 800 } },
  };
}

function buildSceneStep(
  index: number,
  overrides: Partial<VjSceneStepRead> = {},
): VjSceneStepRead {
  return {
    kind: 'scene',
    itemId: ITEM_IDS[index] ?? ITEM_A,
    index,
    sceneId: SCENE_ID,
    look: buildLook(),
    duration: EIGHT_SECONDS,
    ...overrides,
  };
}

function buildClipStep(
  index: number,
  overrides: Partial<VjClipStepRead> = {},
): VjClipStepRead {
  return {
    kind: 'clip',
    itemId: ITEM_IDS[index] ?? ITEM_A,
    index,
    clipId: CLIP_ID,
    duration: EIGHT_SECONDS,
    ...overrides,
  };
}

function buildRead(
  step: VjSetlistStepRead | null,
  overrides: Partial<VjSetlistRead> = {},
): VjSetlistRead {
  return {
    setlistId: SETLIST_ID,
    isLooping: false,
    stepDuration: EIGHT_SECONDS,
    itemIds: [...ITEM_IDS],
    step,
    ...overrides,
  };
}

function buildPlayback(
  overrides: Partial<VjSetlistPlayback> = {},
): VjSetlistPlayback {
  return { ...createVjSetlistPlayback(false), ...overrides };
}

/** A stage with the set list active and the given status running at index 1. */
function buildSequenceState(
  status: VjSetlistPlayback['status'],
  playbackOverrides: Partial<VjSetlistPlayback> = {},
  stateOverrides: Partial<VjStageState> = {},
): VjStageState {
  return buildState({
    activeSetlistId: SETLIST_ID,
    setlistIndex: 1,
    setlistPlayback: buildPlayback({
      status,
      itemId: ITEM_B,
      ...playbackOverrides,
    }),
    ...stateOverrides,
  });
}

function buildPlayingState(
  stateOverrides: Partial<VjStageState> = {},
  playbackOverrides: Partial<VjSetlistPlayback> = {},
): VjStageState {
  return buildSequenceState(
    'playing',
    {
      stepStartedAt: NOW,
      stepEndsAt: NOW + 8000,
      stepDurationMs: 8000,
      ...playbackOverrides,
    },
    stateOverrides,
  );
}

function acceptedOf(result: VjSetlistTransitionResult): VjSetlistTransition {
  if (result.transition === null) {
    throw new Error(`expected a transition, got ${String(result.code)}`);
  }
  return result.transition;
}

function refusal(code: VjSetlistRefusalCode): VjSetlistTransitionResult {
  return { code, transition: null };
}

describe('vj sequences: constants and helpers', () => {
  it('lists the kinds, statuses and beat counts', () => {
    expect(VJ_SETLIST_ITEM_KINDS).toEqual(['scene', 'clip']);
    expect(VJ_STEP_DURATION_KINDS).toEqual(['seconds', 'beats']);
    expect(VJ_STEP_BEAT_COUNTS).toEqual([4, 8, 16, 32, 64]);
    expect(VJ_SETLIST_PLAYBACK_STATUSES).toEqual([
      'manual',
      'playing',
      'paused',
      'takenOver',
      'finished',
      'needsFlashConsent',
    ]);
  });

  it('freezes the default step length at 8 seconds', () => {
    expect(DEFAULT_VJ_STEP_DURATION).toEqual({ kind: 'seconds', value: 8 });
    expect(Object.isFrozen(DEFAULT_VJ_STEP_DURATION)).toBe(true);
  });

  it('builds the default playback with the saved Loop', () => {
    expect(createVjSetlistPlayback(true)).toEqual({
      status: 'manual',
      itemId: null,
      isFlashConfirmed: false,
      stepStartedAt: null,
      stepEndsAt: null,
      stepDurationMs: null,
      pausedRemainingMs: null,
      isLooping: true,
    });
    expect(createVjSetlistPlayback(false).isLooping).toBe(false);
  });

  it('computes step lengths from seconds and from beats at the current tempo', () => {
    const tempo = buildTempo({ bpm: 120 });
    expect(vjStepDurationMs({ kind: 'seconds', value: 8 }, tempo)).toBe(8000);
    expect(vjStepDurationMs({ kind: 'seconds', value: 600 }, tempo)).toBe(
      600_000,
    );
    expect(vjStepDurationMs({ kind: 'beats', value: 16 }, tempo)).toBe(8000);
    expect(
      vjStepDurationMs({ kind: 'beats', value: 16 }, buildTempo({ bpm: 124 })),
    ).toBe(7742);
    expect(
      vjStepDurationMs({ kind: 'beats', value: 4 }, buildTempo({ bpm: 124 })),
    ).toBe(1935);
  });

  it('accepts only in-range step lengths with exactly kind and value', () => {
    for (const valid of [
      { kind: 'seconds', value: 2 },
      { kind: 'seconds', value: 600 },
      { kind: 'seconds', value: 8 },
      { kind: 'beats', value: 4 },
      { kind: 'beats', value: 64 },
    ]) {
      expect(isVjStepDuration(valid)).toBe(true);
    }
    for (const invalid of [
      { kind: 'seconds', value: 1 },
      { kind: 'seconds', value: 601 },
      { kind: 'seconds', value: 2.5 },
      { kind: 'seconds', value: '8' },
      { kind: 'beats', value: 2 },
      { kind: 'beats', value: 128 },
      { kind: 'beats', value: 8.0001 },
      { kind: 'minutes', value: 8 },
      { kind: 'seconds' },
      { value: 8 },
      { kind: 'seconds', value: 8, extra: true },
      [],
      null,
      undefined,
      8,
      'seconds',
    ]) {
      expect(isVjStepDuration(invalid)).toBe(false);
    }
  });

  it('resolves a step length to its own, else the sequence default', () => {
    const own: VjStepDuration = { kind: 'beats', value: 16 };
    expect(vjResolvedStepDuration(own, EIGHT_SECONDS)).toBe(own);
    expect(vjResolvedStepDuration(null, EIGHT_SECONDS)).toBe(EIGHT_SECONDS);
  });

  it('normalises an index read position past the step cap', () => {
    expect(vjSetlistIndexPosition(0, false)).toEqual({
      kind: 'index',
      index: 0,
      wrapsToFirst: false,
    });
    expect(vjSetlistIndexPosition(99, true)).toEqual({
      kind: 'index',
      index: 99,
      wrapsToFirst: true,
    });
    expect(vjSetlistIndexPosition(100, true)).toEqual({
      kind: 'index',
      index: 0,
      wrapsToFirst: false,
    });
    expect(vjSetlistIndexPosition(100, false)).toEqual({ kind: 'count' });
    expect(vjSetlistIndexPosition(250, false)).toEqual({ kind: 'count' });
  });

  it('flags a look that flashes by its transition or by an effect it turns on', () => {
    expect(vjSceneLookFlashes(buildLook(false))).toBe(false);
    expect(vjSceneLookFlashes(buildLook(true))).toBe(true);
    const flashEffectId = VJ_EFFECT_IDS.find(
      (effectId) => VJ_EFFECT_CATALOG[effectId].isFlashCapable,
    );
    expect(flashEffectId).toBeDefined();
    const effectId = flashEffectId as VjEffectId;
    const entry = VJ_EFFECT_CATALOG[effectId];
    const baseLook = buildLook(false);
    const withEffect = (isOn: boolean): VjSceneLook => ({
      ...baseLook,
      effects: {
        ...baseLook.effects,
        settings: {
          [effectId]: {
            isOn,
            amount: entry.defaultAmount,
            variant: entry.defaultVariant,
          },
        },
      },
    });
    expect(vjSceneLookFlashes(withEffect(true))).toBe(true);
    expect(vjSceneLookFlashes(withEffect(false))).toBe(false);
  });

  it('never flashes for a clip step and follows the look for a scene step', () => {
    expect(vjSetlistStepFlashes(buildClipStep(0))).toBe(false);
    expect(vjSetlistStepFlashes(buildSceneStep(0))).toBe(false);
    expect(
      vjSetlistStepFlashes(buildSceneStep(0, { look: buildLook(true) })),
    ).toBe(true);
  });

  it('names a live source change by source, variant, clipSequence or pack', () => {
    const previous = buildState();
    expect(vjIsLiveSourceChange(previous, buildState())).toBe(false);
    expect(
      vjIsLiveSourceChange(previous, buildState({ liveClipId: CLIP_ID })),
    ).toBe(true);
    expect(
      vjIsLiveSourceChange(
        previous,
        buildState({ liveGeneratorId: 'prideFlagWave' }),
      ),
    ).toBe(true);
    expect(
      vjIsLiveSourceChange(
        previous,
        buildState({ liveGeneratorVariant: 'trans' }),
      ),
    ).toBe(true);
    expect(
      vjIsLiveSourceChange(previous, buildState({ clipSequence: 1 })),
    ).toBe(true);
    expect(
      vjIsLiveSourceChange(previous, buildState({ activePackId: PACK_ID })),
    ).toBe(true);
    expect(
      vjIsLiveSourceChange(
        previous,
        buildState({
          mix: { clipId: CLIP_ID, amount: 1, blendMode: 'normal' },
        }),
      ),
    ).toBe(false);
  });

  it('keeps the playback in the canonical form with a lowercased item id', () => {
    const upper = buildSequenceState('manual', {
      itemId: ITEM_B.toUpperCase(),
    });
    const lower = buildSequenceState('manual', { itemId: ITEM_B });
    expect(canonicalVjStageState(upper).setlistPlayback.itemId).toBe(ITEM_B);
    expect(isSameVjStageContent(upper, lower)).toBe(true);
    expect(Object.keys(canonicalVjStageState(lower).setlistPlayback)).toEqual([
      'status',
      'itemId',
      'isFlashConfirmed',
      'stepStartedAt',
      'stepEndsAt',
      'stepDurationMs',
      'pausedRemainingMs',
      'isLooping',
    ]);
    const paused = buildSequenceState('paused', { pausedRemainingMs: 10 });
    expect(isSameVjStageContent(paused, lower)).toBe(false);
  });

  it('fills setlistPlayback in a second upgrade pass', () => {
    const v2Record = JSON.parse(JSON.stringify(buildState())) as Record<
      string,
      unknown
    >;
    delete v2Record.setlistPlayback;
    const filled = upgradeVjStageFieldsV2(v2Record);
    expect(filled.setlistPlayback).toEqual(createVjSetlistPlayback(false));
    expect(filled).not.toBe(v2Record);
    expect(v2Record).not.toHaveProperty('setlistPlayback');

    const withPlayback = JSON.parse(
      JSON.stringify(buildSequenceState('paused', { pausedRemainingMs: 5 })),
    ) as Record<string, unknown>;
    expect(upgradeVjStageFieldsV2(withPlayback)).toBe(withPlayback);

    const upgradedV1 = upgradeVjStageFieldsV2(
      upgradeVjStageFieldsV1(buildV1State(), NOW),
    );
    expect(upgradedV1.setlistPlayback).toEqual(createVjSetlistPlayback(false));
  });
});

describe('vj sequences: setlistSelect', () => {
  it('reads no step to arm, step 0 to play from null, else the index', () => {
    expect(vjSetlistSelectReadPosition(null, false)).toEqual({ kind: 'count' });
    expect(vjSetlistSelectReadPosition(null, true)).toEqual({
      kind: 'index',
      index: 0,
      wrapsToFirst: false,
    });
    expect(vjSetlistSelectReadPosition(3, false)).toEqual({
      kind: 'index',
      index: 3,
      wrapsToFirst: false,
    });
    expect(vjSetlistSelectReadPosition(3, true)).toEqual({
      kind: 'index',
      index: 3,
      wrapsToFirst: false,
    });
    expect(vjSetlistSelectReadPosition(100, true)).toEqual({ kind: 'count' });
  });

  it('clears the active set list for a null id', () => {
    const state = buildPlayingState();
    const transition = acceptedOf(
      vjSetlistSelectTransition(state, {
        setlistId: null,
        index: null,
        isPlaying: false,
        isFlashConfirmed: false,
        read: null,
      }),
    );
    expect(transition.nextState).toEqual(vjSetlistClearedState(state));
    expect(transition.nextState.activeSetlistId).toBeNull();
    expect(transition.nextState.setlistIndex).toBeNull();
    expect(transition.nextState.setlistPlayback).toEqual(
      createVjSetlistPlayback(false),
    );
    expect(transition.show).toBeNull();
    expect(transition.clock).toEqual({ kind: 'clear' });
  });

  it('refuses a set list no read found', () => {
    expect(
      vjSetlistSelectTransition(buildState(), {
        setlistId: SETLIST_ID,
        index: 0,
        isPlaying: false,
        isFlashConfirmed: false,
        read: null,
      }),
    ).toEqual(refusal('vj_setlist_not_found'));
  });

  it('arms the set list with its saved Loop and shows nothing', () => {
    const state = buildPlayingState({ shuffle: buildShuffle({ isOn: true }) });
    const transition = acceptedOf(
      vjSetlistSelectTransition(state, {
        setlistId: SETLIST_ID,
        index: null,
        isPlaying: false,
        isFlashConfirmed: true,
        read: buildRead(null, { isLooping: true }),
      }),
    );
    expect(transition.nextState.activeSetlistId).toBe(SETLIST_ID);
    expect(transition.nextState.setlistIndex).toBeNull();
    expect(transition.nextState.setlistPlayback).toEqual(
      createVjSetlistPlayback(true),
    );
    expect(transition.nextState.shuffle.isOn).toBe(true);
    expect(transition.show).toBeNull();
    expect(transition.clock).toEqual({ kind: 'clear' });
  });

  it('arms an empty set list too, before the empty check', () => {
    const transition = acceptedOf(
      vjSetlistSelectTransition(buildState(), {
        setlistId: SETLIST_ID,
        index: null,
        isPlaying: false,
        isFlashConfirmed: false,
        read: buildRead(null, { itemIds: [] }),
      }),
    );
    expect(transition.nextState.activeSetlistId).toBe(SETLIST_ID);
  });

  it('refuses an empty set list and a missing step', () => {
    const input = {
      setlistId: SETLIST_ID,
      index: 0,
      isPlaying: false,
      isFlashConfirmed: false,
    };
    expect(
      vjSetlistSelectTransition(buildState(), {
        ...input,
        read: buildRead(null, { itemIds: [] }),
      }),
    ).toEqual(refusal('vj_setlist_empty'));
    expect(
      vjSetlistSelectTransition(buildState(), {
        ...input,
        index: 9,
        read: buildRead(null),
      }),
    ).toEqual(refusal('vj_setlist_index_invalid'));
  });

  it('refuses to play a flashing step nobody confirmed, and plays it once confirmed', () => {
    const read = buildRead(buildSceneStep(0, { look: buildLook(true) }));
    const input = {
      setlistId: SETLIST_ID,
      index: 0,
      isPlaying: true,
      isFlashConfirmed: false,
      read,
    };
    expect(vjSetlistSelectTransition(buildState(), input)).toEqual(
      refusal('vj_setlist_flash_unconfirmed'),
    );
    expect(
      vjSetlistSelectTransition(buildState(), {
        ...input,
        isFlashConfirmed: true,
      }).code,
    ).toBeNull();
  });

  it('checks a select against its own payload alone, so an old confirmed run grants nothing', () => {
    const oldRunConfirmed = buildSequenceState('manual', {
      isFlashConfirmed: true,
    });
    expect(
      vjSetlistSelectTransition(oldRunConfirmed, {
        setlistId: SETLIST_ID,
        index: 0,
        isPlaying: true,
        isFlashConfirmed: false,
        read: buildRead(buildSceneStep(0, { look: buildLook(true) })),
      }),
    ).toEqual(refusal('vj_setlist_flash_unconfirmed'));
  });

  it('shows one step by hand and stays manual', () => {
    const step = buildSceneStep(2, { look: buildLook(true) });
    const state = buildSequenceState('paused', {
      stepDurationMs: 4000,
      pausedRemainingMs: 1000,
    });
    const transition = acceptedOf(
      vjSetlistSelectTransition(state, {
        setlistId: SETLIST_ID,
        index: 2,
        isPlaying: false,
        isFlashConfirmed: false,
        read: buildRead(step, { isLooping: true }),
      }),
    );
    expect(transition.show).toEqual({ kind: 'scene', look: step.look });
    expect(transition.clock).toEqual({ kind: 'clear' });
    expect(transition.nextState.activeSetlistId).toBe(SETLIST_ID);
    expect(transition.nextState.setlistIndex).toBe(2);
    expect(transition.nextState.setlistPlayback).toEqual(
      buildPlayback({ status: 'manual', itemId: ITEM_C, isLooping: true }),
    );
  });

  it('stores the payload flash flag when showing a step by hand', () => {
    const transition = acceptedOf(
      vjSetlistSelectTransition(buildState(), {
        setlistId: SETLIST_ID,
        index: 0,
        isPlaying: false,
        isFlashConfirmed: true,
        read: buildRead(buildClipStep(0)),
      }),
    );
    expect(transition.nextState.setlistPlayback.isFlashConfirmed).toBe(true);
    expect(transition.show).toEqual({ kind: 'clip', clipId: CLIP_ID });
  });

  it('plays from the step: playing, shuffle off, clock start(full, full)', () => {
    const state = buildState({
      shuffle: buildShuffle({ isOn: true }),
      setlistPlayback: buildPlayback({
        status: 'finished',
        stepDurationMs: 99,
      }),
    });
    const transition = acceptedOf(
      vjSetlistSelectTransition(state, {
        setlistId: SETLIST_ID,
        index: null,
        isPlaying: true,
        isFlashConfirmed: true,
        read: buildRead(buildClipStep(0), { isLooping: true }),
      }),
    );
    expect(transition.show).toEqual({ kind: 'clip', clipId: CLIP_ID });
    expect(transition.clock).toEqual({
      kind: 'start',
      durationMs: 8000,
      remainingMs: 8000,
    });
    expect(transition.nextState.shuffle.isOn).toBe(false);
    expect(transition.nextState.activeSetlistId).toBe(SETLIST_ID);
    expect(transition.nextState.setlistIndex).toBe(0);
    expect(transition.nextState.setlistPlayback).toEqual({
      status: 'playing',
      itemId: ITEM_A,
      isFlashConfirmed: true,
      stepStartedAt: null,
      stepEndsAt: null,
      stepDurationMs: 8000,
      pausedRemainingMs: null,
      isLooping: true,
    });
  });

  it('measures a beats step at the tempo of the moment', () => {
    const step = buildSceneStep(0, { duration: { kind: 'beats', value: 16 } });
    const transition = acceptedOf(
      vjSetlistSelectTransition(
        buildState({ tempo: buildTempo({ bpm: 120 }) }),
        {
          setlistId: SETLIST_ID,
          index: 0,
          isPlaying: true,
          isFlashConfirmed: false,
          read: buildRead(step),
        },
      ),
    );
    expect(transition.clock).toEqual({
      kind: 'start',
      durationMs: 8000,
      remainingMs: 8000,
    });
  });

  it('starts a fresh run: no field of the old run survives', () => {
    const state = buildSequenceState('paused', {
      stepDurationMs: 4000,
      pausedRemainingMs: 1500,
      isFlashConfirmed: true,
    });
    const transition = acceptedOf(
      vjSetlistSelectTransition(state, {
        setlistId: SETLIST_ID,
        index: 0,
        isPlaying: true,
        isFlashConfirmed: false,
        read: buildRead(buildClipStep(0)),
      }),
    );
    expect(transition.nextState.setlistPlayback.pausedRemainingMs).toBeNull();
    expect(transition.nextState.setlistPlayback.isFlashConfirmed).toBe(false);
    expect(transition.nextState.setlistPlayback.stepDurationMs).toBe(8000);
  });
});

describe('vj sequences: setlistSetPlaying', () => {
  it('reads no step when pausing or when a clock exists, else by status', () => {
    const cases: Array<[VjStageState, boolean, VjSetlistReadPosition | null]> =
      [
        [buildPlayingState(), false, null],
        [buildSequenceState('manual'), false, null],
        [buildPlayingState(), true, null],
        [buildSequenceState('paused'), true, null],
        [
          buildSequenceState('manual'),
          true,
          { kind: 'index', index: 1, wrapsToFirst: false },
        ],
        [
          buildSequenceState('manual', {}, { setlistIndex: null }),
          true,
          { kind: 'index', index: 0, wrapsToFirst: false },
        ],
        [
          buildSequenceState('takenOver'),
          true,
          { kind: 'index', index: 2, wrapsToFirst: true },
        ],
        [
          buildSequenceState('takenOver', {}, { setlistIndex: null }),
          true,
          { kind: 'index', index: 0, wrapsToFirst: true },
        ],
        [
          buildSequenceState('finished'),
          true,
          { kind: 'index', index: 0, wrapsToFirst: false },
        ],
        [
          buildSequenceState('needsFlashConsent', { isLooping: false }),
          true,
          { kind: 'index', index: 2, wrapsToFirst: false },
        ],
        [
          buildSequenceState('needsFlashConsent', { isLooping: true }),
          true,
          { kind: 'index', index: 2, wrapsToFirst: true },
        ],
        [
          buildSequenceState(
            'needsFlashConsent',
            { isLooping: true },
            {
              setlistIndex: 99,
            },
          ),
          true,
          { kind: 'index', index: 0, wrapsToFirst: false },
        ],
        [
          buildSequenceState(
            'needsFlashConsent',
            { isLooping: false },
            {
              setlistIndex: 99,
            },
          ),
          true,
          { kind: 'count' },
        ],
      ];
    for (const [state, isPlaying, expected] of cases) {
      expect(vjSetlistSetPlayingReadPosition(state, isPlaying)).toEqual(
        expected,
      );
    }
  });

  it('pauses a running step with the time left', () => {
    const state = buildPlayingState();
    const transition = acceptedOf(
      vjSetlistSetPlayingTransition(state, {
        isPlaying: false,
        isFlashConfirmed: false,
        read: null,
        now: NOW + 3000,
      }),
    );
    expect(transition.nextState.setlistPlayback).toEqual(
      buildPlayback({
        status: 'paused',
        itemId: ITEM_B,
        stepDurationMs: 8000,
        pausedRemainingMs: 5000,
      }),
    );
    expect(transition.nextState.setlistIndex).toBe(1);
    expect(transition.show).toBeNull();
    expect(transition.clock).toEqual({ kind: 'clear' });
  });

  it('pauses with zero left once the step end has passed', () => {
    const transition = acceptedOf(
      vjSetlistSetPlayingTransition(buildPlayingState(), {
        isPlaying: false,
        isFlashConfirmed: false,
        read: null,
        now: NOW + 20_000,
      }),
    );
    expect(transition.nextState.setlistPlayback.pausedRemainingMs).toBe(0);
  });

  it('never pauses with more time left than the step length', () => {
    const state = buildPlayingState(
      {},
      { stepStartedAt: NOW + 4000, stepEndsAt: NOW + 12_000 },
    );
    const transition = acceptedOf(
      vjSetlistSetPlayingTransition(state, {
        isPlaying: false,
        isFlashConfirmed: false,
        read: null,
        now: NOW,
      }),
    );
    expect(transition.nextState.setlistPlayback.pausedRemainingMs).toBe(8000);
  });

  it('answers a pause outside playing as an accepted noop', () => {
    for (const status of [
      'manual',
      'paused',
      'takenOver',
      'finished',
      'needsFlashConsent',
    ] as const) {
      const state = buildSequenceState(status);
      const transition = acceptedOf(
        vjSetlistSetPlayingTransition(state, {
          isPlaying: false,
          isFlashConfirmed: false,
          read: null,
          now: NOW,
        }),
      );
      expect(transition.nextState).toBe(state);
      expect(transition.show).toBeNull();
      expect(transition.clock).toEqual({ kind: 'keep' });
    }
  });

  it('answers Play while playing as a noop, storing a confirmation', () => {
    const state = buildPlayingState();
    const noop = acceptedOf(
      vjSetlistSetPlayingTransition(state, {
        isPlaying: true,
        isFlashConfirmed: false,
        read: null,
        now: NOW,
      }),
    );
    expect(noop.nextState).toBe(state);
    expect(noop.clock).toEqual({ kind: 'keep' });
    const confirmed = acceptedOf(
      vjSetlistSetPlayingTransition(state, {
        isPlaying: true,
        isFlashConfirmed: true,
        read: null,
        now: NOW,
      }),
    );
    expect(confirmed.nextState.setlistPlayback.isFlashConfirmed).toBe(true);
    expect(confirmed.clock).toEqual({ kind: 'keep' });
  });

  it('resumes a paused step from the time left, shuffle off', () => {
    const state = buildSequenceState(
      'paused',
      { stepDurationMs: 8000, pausedRemainingMs: 5000 },
      { shuffle: buildShuffle({ isOn: true }) },
    );
    const transition = acceptedOf(
      vjSetlistSetPlayingTransition(state, {
        isPlaying: true,
        isFlashConfirmed: false,
        read: null,
        now: NOW,
      }),
    );
    expect(transition.clock).toEqual({
      kind: 'start',
      durationMs: 8000,
      remainingMs: 5000,
    });
    expect(transition.show).toBeNull();
    expect(transition.nextState.shuffle.isOn).toBe(false);
    expect(transition.nextState.setlistPlayback.status).toBe('playing');
    expect(transition.nextState.setlistPlayback.pausedRemainingMs).toBeNull();
    expect(transition.nextState.setlistPlayback.stepDurationMs).toBe(8000);
  });

  it('resumes a paused step with no stored length from the time left', () => {
    const state = buildSequenceState('paused', {
      stepDurationMs: null,
      pausedRemainingMs: 3000,
    });
    const transition = acceptedOf(
      vjSetlistSetPlayingTransition(state, {
        isPlaying: true,
        isFlashConfirmed: false,
        read: null,
        now: NOW,
      }),
    );
    expect(transition.clock).toEqual({
      kind: 'start',
      durationMs: 3000,
      remainingMs: 3000,
    });
  });

  it('plays the manual step in place: no recall, no flash check', () => {
    const step = buildSceneStep(1, { look: buildLook(true) });
    const state = buildSequenceState(
      'manual',
      {},
      { shuffle: buildShuffle({ isOn: true }) },
    );
    const transition = acceptedOf(
      vjSetlistSetPlayingTransition(state, {
        isPlaying: true,
        isFlashConfirmed: false,
        read: buildRead(step, { isLooping: true }),
        now: NOW,
      }),
    );
    expect(transition.show).toBeNull();
    expect(transition.clock).toEqual({
      kind: 'start',
      durationMs: 8000,
      remainingMs: 8000,
    });
    expect(transition.nextState.shuffle.isOn).toBe(false);
    expect(transition.nextState.setlistIndex).toBe(1);
    expect(transition.nextState.setlistPlayback).toEqual(
      buildPlayback({
        status: 'playing',
        itemId: ITEM_B,
        stepDurationMs: 8000,
        isLooping: true,
      }),
    );
  });

  it('refuses a manual play whose read found nothing', () => {
    const state = buildSequenceState('manual');
    const input = { isPlaying: true, isFlashConfirmed: false, now: NOW };
    expect(
      vjSetlistSetPlayingTransition(state, { ...input, read: null }),
    ).toEqual(refusal('vj_setlist_not_found'));
    expect(
      vjSetlistSetPlayingTransition(state, {
        ...input,
        read: buildRead(null, { itemIds: [] }),
      }),
    ).toEqual(refusal('vj_setlist_empty'));
    expect(
      vjSetlistSetPlayingTransition(state, { ...input, read: buildRead(null) }),
    ).toEqual(refusal('vj_setlist_index_invalid'));
  });

  it('plays step 1 from a manual run with no index, like finished', () => {
    const state = buildSequenceState(
      'manual',
      { itemId: null },
      { setlistIndex: null },
    );
    const transition = acceptedOf(
      vjSetlistSetPlayingTransition(state, {
        isPlaying: true,
        isFlashConfirmed: false,
        read: buildRead(buildClipStep(0)),
        now: NOW,
      }),
    );
    expect(transition.show).toEqual({ kind: 'clip', clipId: CLIP_ID });
    expect(transition.nextState.setlistIndex).toBe(0);
    expect(transition.nextState.setlistPlayback.itemId).toBe(ITEM_A);
    expect(transition.nextState.setlistPlayback.status).toBe('playing');
    expect(
      vjSetlistSetPlayingTransition(state, {
        isPlaying: true,
        isFlashConfirmed: false,
        read: buildRead(buildSceneStep(0, { look: buildLook(true) })),
        now: NOW,
      }),
    ).toEqual(refusal('vj_setlist_flash_unconfirmed'));
  });

  it('plays from the read step out of takenOver, finished and needsFlashConsent', () => {
    for (const status of [
      'takenOver',
      'finished',
      'needsFlashConsent',
    ] as const) {
      const state = buildSequenceState(
        status,
        { stepDurationMs: 123 },
        { shuffle: buildShuffle({ isOn: true }) },
      );
      const input = { isPlaying: true, isFlashConfirmed: false, now: NOW };
      expect(
        vjSetlistSetPlayingTransition(state, { ...input, read: null }),
      ).toEqual(refusal('vj_setlist_not_found'));
      expect(
        vjSetlistSetPlayingTransition(state, {
          ...input,
          read: buildRead(null, { itemIds: [] }),
        }),
      ).toEqual(refusal('vj_setlist_empty'));
      expect(
        vjSetlistSetPlayingTransition(state, {
          ...input,
          read: buildRead(null),
        }),
      ).toEqual(refusal('vj_setlist_index_invalid'));
      expect(
        vjSetlistSetPlayingTransition(state, {
          ...input,
          read: buildRead(buildSceneStep(2, { look: buildLook(true) })),
        }),
      ).toEqual(refusal('vj_setlist_flash_unconfirmed'));

      const transition = acceptedOf(
        vjSetlistSetPlayingTransition(state, {
          ...input,
          read: buildRead(buildClipStep(2), { isLooping: true }),
        }),
      );
      expect(transition.nextState.setlistPlayback.stepDurationMs).toBe(8000);
      expect(transition.nextState.setlistPlayback.isLooping).toBe(true);
      expect(transition.show).toEqual({ kind: 'clip', clipId: CLIP_ID });
      expect(transition.clock).toEqual({
        kind: 'start',
        durationMs: 8000,
        remainingMs: 8000,
      });
      expect(transition.nextState.shuffle.isOn).toBe(false);
      expect(transition.nextState.setlistIndex).toBe(2);
      expect(transition.nextState.setlistPlayback.status).toBe('playing');
      expect(transition.nextState.setlistPlayback.itemId).toBe(ITEM_C);
    }
  });

  it('stores a confirmation on every accepted Play and lets it pass the flash check', () => {
    const flashingRead = buildRead(
      buildSceneStep(2, { look: buildLook(true) }),
    );
    for (const status of [
      'takenOver',
      'finished',
      'needsFlashConsent',
    ] as const) {
      const transition = acceptedOf(
        vjSetlistSetPlayingTransition(buildSequenceState(status), {
          isPlaying: true,
          isFlashConfirmed: true,
          read: flashingRead,
          now: NOW,
        }),
      );
      expect(transition.nextState.setlistPlayback.isFlashConfirmed).toBe(true);
    }
    const resumed = acceptedOf(
      vjSetlistSetPlayingTransition(
        buildSequenceState('paused', {
          stepDurationMs: 8000,
          pausedRemainingMs: 100,
        }),
        { isPlaying: true, isFlashConfirmed: true, read: null, now: NOW },
      ),
    );
    expect(resumed.nextState.setlistPlayback.isFlashConfirmed).toBe(true);
    const inPlace = acceptedOf(
      vjSetlistSetPlayingTransition(buildSequenceState('manual'), {
        isPlaying: true,
        isFlashConfirmed: true,
        read: buildRead(buildSceneStep(1)),
        now: NOW,
      }),
    );
    expect(inPlace.nextState.setlistPlayback.isFlashConfirmed).toBe(true);
  });

  it('keeps a stored confirmation when the payload carries none', () => {
    const state = buildSequenceState('finished', { isFlashConfirmed: true });
    const transition = acceptedOf(
      vjSetlistSetPlayingTransition(state, {
        isPlaying: true,
        isFlashConfirmed: false,
        read: buildRead(buildSceneStep(0, { look: buildLook(true) })),
        now: NOW,
      }),
    );
    expect(transition.nextState.setlistPlayback.isFlashConfirmed).toBe(true);
  });
});

/** Every playback status a Next or Previous can start from. */
const VJ_STEP_TEST_STATUSES = [
  'manual',
  'playing',
  'paused',
  'takenOver',
  'finished',
  'needsFlashConsent',
] as const;

/** A stage at index 1 in `status`, running its clock when playing. */
function buildStepTestState(
  status: (typeof VJ_STEP_TEST_STATUSES)[number],
  playbackOverrides: Partial<VjSetlistPlayback> = {},
): VjStageState {
  return status === 'playing'
    ? buildPlayingState({}, playbackOverrides)
    : buildSequenceState(status, playbackOverrides);
}

describe('vj sequences: Next and Previous', () => {
  it('reads the step after the index for Next, wrapping with Loop', () => {
    expect(
      vjSetlistStepReadPosition(buildSequenceState('manual'), 'next'),
    ).toEqual({ kind: 'index', index: 2, wrapsToFirst: false });
    expect(
      vjSetlistStepReadPosition(
        buildSequenceState('manual', { isLooping: true }),
        'next',
      ),
    ).toEqual({ kind: 'index', index: 2, wrapsToFirst: true });
    expect(
      vjSetlistStepReadPosition(
        buildSequenceState('manual', {}, { setlistIndex: null }),
        'next',
      ),
    ).toEqual({ kind: 'index', index: 0, wrapsToFirst: false });
    expect(
      vjSetlistStepReadPosition(
        buildSequenceState('manual', { isLooping: true }, { setlistIndex: 99 }),
        'next',
      ),
    ).toEqual({ kind: 'index', index: 0, wrapsToFirst: false });
    expect(
      vjSetlistStepReadPosition(
        buildSequenceState('manual', {}, { setlistIndex: 99 }),
        'next',
      ),
    ).toEqual({ kind: 'count' });
  });

  it('reads the step before the index for Previous, the last step or none at the start', () => {
    expect(
      vjSetlistStepReadPosition(buildSequenceState('manual'), 'previous'),
    ).toEqual({ kind: 'index', index: 0, wrapsToFirst: false });
    for (const setlistIndex of [0, null]) {
      expect(
        vjSetlistStepReadPosition(
          buildSequenceState('manual', {}, { setlistIndex }),
          'previous',
        ),
      ).toEqual({ kind: 'count' });
      expect(
        vjSetlistStepReadPosition(
          buildSequenceState('manual', { isLooping: true }, { setlistIndex }),
          'previous',
        ),
      ).toEqual({ kind: 'last' });
    }
  });

  it('refuses by case in the contract order', () => {
    const manual = buildSequenceState('manual');
    const atStart = buildSequenceState('manual', {}, { setlistIndex: 0 });
    expect(
      vjSetlistStepTransition(manual, { direction: 'next', read: null }),
    ).toEqual(refusal('vj_setlist_not_found'));
    expect(
      vjSetlistStepTransition(manual, {
        direction: 'next',
        read: buildRead(null, { itemIds: [] }),
      }),
    ).toEqual(refusal('vj_setlist_empty'));
    expect(
      vjSetlistStepTransition(atStart, {
        direction: 'previous',
        read: buildRead(null),
      }),
    ).toEqual(refusal('vj_setlist_start'));
    expect(
      vjSetlistStepTransition(manual, {
        direction: 'next',
        read: buildRead(null),
      }),
    ).toEqual(refusal('vj_setlist_end'));
    expect(
      vjSetlistStepTransition(manual, {
        direction: 'previous',
        read: buildRead(null),
      }),
    ).toEqual(refusal('vj_setlist_index_invalid'));
  });

  it('shows the step and restarts the clock while playing', () => {
    const state = buildPlayingState();
    const step = buildSceneStep(2, {
      duration: { kind: 'beats', value: 16 },
      look: buildLook(true),
    });
    const transition = acceptedOf(
      vjSetlistStepTransition(
        { ...state, tempo: buildTempo({ bpm: 120 }) },
        {
          direction: 'next',
          isFlashConfirmed: true,
          read: buildRead(step, { isLooping: true }),
        },
      ),
    );
    expect(transition.show).toEqual({ kind: 'scene', look: step.look });
    expect(transition.clock).toEqual({
      kind: 'start',
      durationMs: 8000,
      remainingMs: 8000,
    });
    expect(transition.nextState.setlistIndex).toBe(2);
    expect(transition.nextState.setlistPlayback).toEqual(
      buildPlayback({
        status: 'playing',
        itemId: ITEM_C,
        stepDurationMs: 8000,
        isLooping: true,
      }),
    );
  });

  it('shows the step and stays manual without a clock', () => {
    const transition = acceptedOf(
      vjSetlistStepTransition(buildSequenceState('manual'), {
        direction: 'next',
        read: buildRead(buildClipStep(2)),
      }),
    );
    expect(transition.show).toEqual({ kind: 'clip', clipId: CLIP_ID });
    expect(transition.clock).toEqual({ kind: 'clear' });
    expect(transition.nextState.setlistPlayback).toEqual(
      buildPlayback({ status: 'manual', itemId: ITEM_C }),
    );
  });

  it('copies the saved Loop of the read in manual and paused runs', () => {
    for (const status of ['manual', 'paused'] as const) {
      for (const direction of ['next', 'previous'] as const) {
        const state = buildSequenceState(status, { isLooping: false });
        const step = buildClipStep(direction === 'next' ? 2 : 0);
        const transition = acceptedOf(
          vjSetlistStepTransition(state, {
            direction,
            read: buildRead(step, { isLooping: true }),
          }),
        );
        expect(transition.nextState.setlistPlayback.isLooping).toBe(true);
      }
    }
  });

  it('pauses on the new step with its full length from every other status', () => {
    for (const status of [
      'paused',
      'takenOver',
      'finished',
      'needsFlashConsent',
    ] as const) {
      const state = buildSequenceState(status, {
        stepDurationMs: 1,
        pausedRemainingMs: status === 'paused' ? 1 : null,
      });
      const transition = acceptedOf(
        vjSetlistStepTransition(state, {
          direction: 'previous',
          isFlashConfirmed: true,
          read: buildRead(buildSceneStep(0, { look: buildLook(true) })),
        }),
      );
      expect(transition.clock).toEqual({ kind: 'clear' });
      expect(transition.show?.kind).toBe('scene');
      expect(transition.nextState.setlistIndex).toBe(0);
      expect(transition.nextState.setlistPlayback).toEqual(
        buildPlayback({
          status: 'paused',
          itemId: ITEM_A,
          stepDurationMs: 8000,
          pausedRemainingMs: 8000,
        }),
      );
    }
  });

  it('refuses a flashing step nobody confirmed in every status, both ways', () => {
    for (const status of VJ_STEP_TEST_STATUSES) {
      for (const direction of ['next', 'previous'] as const) {
        const state = buildStepTestState(status);
        const flashingStep = buildSceneStep(direction === 'next' ? 2 : 0, {
          look: buildLook(true),
        });
        expect(
          vjSetlistStepTransition(state, {
            direction,
            read: buildRead(flashingStep),
          }),
        ).toEqual(refusal('vj_setlist_flash_unconfirmed'));
        expect(
          vjSetlistStepTransition(state, {
            direction,
            isFlashConfirmed: false,
            read: buildRead(flashingStep),
          }),
        ).toEqual(refusal('vj_setlist_flash_unconfirmed'));
      }
    }
  });

  it('lands a flashing step the tap confirmed and keeps the stored run flag', () => {
    for (const status of VJ_STEP_TEST_STATUSES) {
      const transition = acceptedOf(
        vjSetlistStepTransition(buildStepTestState(status), {
          direction: 'next',
          isFlashConfirmed: true,
          read: buildRead(buildSceneStep(2, { look: buildLook(true) })),
        }),
      );
      expect(transition.show?.kind).toBe('scene');
      expect(transition.nextState.setlistIndex).toBe(2);
      expect(transition.nextState.setlistPlayback.isFlashConfirmed).toBe(false);
    }
  });

  it('lands a flashing step the stored run flag confirmed', () => {
    for (const status of VJ_STEP_TEST_STATUSES) {
      const transition = acceptedOf(
        vjSetlistStepTransition(
          buildStepTestState(status, { isFlashConfirmed: true }),
          {
            direction: 'previous',
            read: buildRead(buildSceneStep(0, { look: buildLook(true) })),
          },
        ),
      );
      expect(transition.nextState.setlistIndex).toBe(0);
      expect(transition.nextState.setlistPlayback.isFlashConfirmed).toBe(true);
    }
  });

  it('lands clip steps and steady scene steps with no confirmation', () => {
    for (const step of [
      buildClipStep(2),
      buildSceneStep(2, { look: buildLook() }),
    ]) {
      expect(
        vjSetlistStepTransition(buildSequenceState('manual'), {
          direction: 'next',
          read: buildRead(step),
        }).code,
      ).toBeNull();
    }
  });

  it('answers the read refusals before the flash check', () => {
    const flashingFirstStep = buildSceneStep(0, { look: buildLook(true) });
    expect(
      vjSetlistStepTransition(
        buildSequenceState('manual', {}, { setlistIndex: 0 }),
        { direction: 'previous', read: buildRead(flashingFirstStep) },
      ),
    ).toEqual(refusal('vj_setlist_start'));
    expect(
      vjSetlistStepTransition(buildSequenceState('manual'), {
        direction: 'next',
        read: buildRead(flashingFirstStep, { itemIds: [] }),
      }),
    ).toEqual(refusal('vj_setlist_empty'));
    expect(
      vjSetlistStepTransition(buildSequenceState('manual'), {
        direction: 'next',
        read: null,
      }),
    ).toEqual(refusal('vj_setlist_not_found'));
  });

  it('turns shuffle off when the step lands paused', () => {
    for (const status of [
      'paused',
      'takenOver',
      'finished',
      'needsFlashConsent',
    ] as const) {
      const base = buildSequenceState(status);
      const state = { ...base, shuffle: { ...base.shuffle, isOn: true } };
      const transition = acceptedOf(
        vjSetlistStepTransition(state, {
          direction: 'next',
          read: buildRead(buildClipStep(2)),
        }),
      );
      expect(transition.nextState.setlistPlayback.status).toBe('paused');
      expect(transition.nextState.shuffle).toEqual({
        ...state.shuffle,
        isOn: false,
      });
    }
  });
});

describe('vj sequences: the step timer', () => {
  it('targets the step end less the early lead, only while playing', () => {
    expect(vjSetlistTimerTargetAt(buildPlayingState())).toBe(NOW + 8000 - 300);
    expect(vjSetlistTimerTargetAt(buildSequenceState('paused'))).toBeNull();
    expect(vjSetlistTimerTargetAt(buildSequenceState('manual'))).toBeNull();
    expect(
      vjSetlistTimerTargetAt(
        buildSequenceState('playing', { stepEndsAt: null }),
      ),
    ).toBeNull();
  });

  it('reads the step after the index while a timer is armed', () => {
    expect(vjSetlistTimerReadPosition(buildPlayingState())).toEqual({
      kind: 'index',
      index: 2,
      wrapsToFirst: false,
    });
    expect(
      vjSetlistTimerReadPosition(buildPlayingState({}, { isLooping: true })),
    ).toEqual({ kind: 'index', index: 2, wrapsToFirst: true });
    expect(
      vjSetlistTimerReadPosition(buildPlayingState({ setlistIndex: null })),
    ).toEqual({ kind: 'index', index: 0, wrapsToFirst: false });
    expect(
      vjSetlistTimerReadPosition(
        buildPlayingState({ setlistIndex: 99 }, { isLooping: true }),
      ),
    ).toEqual({ kind: 'index', index: 0, wrapsToFirst: false });
    expect(
      vjSetlistTimerReadPosition(buildPlayingState({ setlistIndex: 99 })),
    ).toEqual({ kind: 'count' });
    expect(vjSetlistTimerReadPosition(buildSequenceState('paused'))).toBeNull();
    expect(
      vjSetlistTimerReadPosition(buildPlayingState({ activeSetlistId: null })),
    ).toBeNull();
  });

  it('lands nothing when the state or the read does not match', () => {
    const read = buildRead(buildClipStep(2));
    expect(
      vjSetlistTimerTransition(buildSequenceState('paused'), read),
    ).toBeNull();
    expect(
      vjSetlistTimerTransition(buildSequenceState('manual'), read),
    ).toBeNull();
    expect(
      vjSetlistTimerTransition(
        buildPlayingState({ activeSetlistId: null }),
        read,
      ),
    ).toBeNull();
    expect(vjSetlistTimerTransition(buildPlayingState(), null)).toBeNull();
    expect(
      vjSetlistTimerTransition(
        buildPlayingState(),
        buildRead(buildClipStep(2), { setlistId: OTHER_SETLIST_ID }),
      ),
    ).toBeNull();
  });

  it('matches the read set list id without regard to case', () => {
    const transition = vjSetlistTimerTransition(
      buildPlayingState({ activeSetlistId: SETLIST_ID.toUpperCase() }),
      buildRead(buildClipStep(2)),
    );
    expect(transition).not.toBeNull();
  });

  it('goes back to manual with no index when the set list emptied', () => {
    const transition = vjSetlistTimerTransition(
      buildPlayingState(),
      buildRead(null, { itemIds: [], isLooping: true }),
    );
    expect(transition).not.toBeNull();
    expect(transition?.show).toBeNull();
    expect(transition?.clock).toEqual({ kind: 'clear' });
    expect(transition?.nextState.setlistIndex).toBeNull();
    expect(transition?.nextState.setlistPlayback).toEqual(
      buildPlayback({ status: 'manual', itemId: null, isLooping: true }),
    );
  });

  it('finishes past the end, keeping the index and item id', () => {
    const transition = vjSetlistTimerTransition(
      buildPlayingState({ setlistIndex: 3 }, { itemId: ITEM_D }),
      buildRead(null),
    );
    expect(transition?.show).toBeNull();
    expect(transition?.clock).toEqual({ kind: 'clear' });
    expect(transition?.nextState.setlistIndex).toBe(3);
    expect(transition?.nextState.setlistPlayback).toEqual(
      buildPlayback({
        status: 'finished',
        itemId: ITEM_D,
        stepDurationMs: 8000,
      }),
    );
  });

  it('waits for consent before a flashing step, keeping the step on screen', () => {
    const transition = vjSetlistTimerTransition(
      buildPlayingState(),
      buildRead(buildSceneStep(2, { look: buildLook(true) })),
    );
    expect(transition?.show).toBeNull();
    expect(transition?.clock).toEqual({ kind: 'clear' });
    expect(transition?.nextState.setlistIndex).toBe(1);
    expect(transition?.nextState.setlistPlayback).toEqual(
      buildPlayback({
        status: 'needsFlashConsent',
        itemId: ITEM_B,
        stepDurationMs: 8000,
      }),
    );
  });

  it('plays a flashing step once the stored flag is set, and never flashes a clip', () => {
    const confirmed = vjSetlistTimerTransition(
      buildPlayingState({}, { isFlashConfirmed: true }),
      buildRead(buildSceneStep(2, { look: buildLook(true) })),
    );
    expect(confirmed?.show?.kind).toBe('scene');
    expect(confirmed?.clock).toEqual({
      kind: 'start',
      durationMs: 8000,
      remainingMs: 8000,
    });
    const stamped = stampVjSetlistClock(
      (confirmed as VjSetlistTransition).nextState.setlistPlayback,
      (confirmed as VjSetlistTransition).clock,
      NOW + 7700,
    );
    expect(stamped).toEqual(
      buildPlayback({
        status: 'playing',
        itemId: ITEM_C,
        isFlashConfirmed: true,
        stepStartedAt: NOW + 7700,
        stepEndsAt: NOW + 15_700,
        stepDurationMs: 8000,
      }),
    );
    const clip = vjSetlistTimerTransition(
      buildPlayingState(),
      buildRead(buildClipStep(2)),
    );
    expect(clip?.show).toEqual({ kind: 'clip', clipId: CLIP_ID });
  });

  it('shows the next step and restarts the clock', () => {
    const transition = vjSetlistTimerTransition(
      buildPlayingState(),
      buildRead(buildClipStep(2, { duration: { kind: 'beats', value: 8 } }), {
        isLooping: true,
      }),
    );
    expect(transition?.clock).toEqual({
      kind: 'start',
      durationMs: 3871,
      remainingMs: 3871,
    });
    expect(transition?.nextState.setlistIndex).toBe(2);
    expect(transition?.nextState.setlistPlayback).toEqual(
      buildPlayback({
        status: 'playing',
        itemId: ITEM_C,
        stepDurationMs: 3871,
        isLooping: true,
      }),
    );
  });

  it('wraps to step 0 with Loop', () => {
    const transition = vjSetlistTimerTransition(
      buildPlayingState(
        { setlistIndex: 3 },
        { itemId: ITEM_D, isLooping: true },
      ),
      buildRead(buildClipStep(0), { isLooping: true }),
    );
    expect(transition?.nextState.setlistIndex).toBe(0);
    expect(transition?.nextState.setlistPlayback.itemId).toBe(ITEM_A);
  });
});

describe('vj sequences: takeover, Loop and clear', () => {
  it('takes over a running, paused or flash-waiting sequence on a source change', () => {
    for (const status of ['playing', 'paused', 'needsFlashConsent'] as const) {
      const previous = buildSequenceState(status, {
        stepStartedAt: status === 'playing' ? NOW : null,
        stepEndsAt: status === 'playing' ? NOW + 8000 : null,
        stepDurationMs: 8000,
        pausedRemainingMs: status === 'paused' ? 3000 : null,
        isFlashConfirmed: true,
      });
      const next = { ...previous, liveClipId: CLIP_ID };
      const taken = vjSetlistTakeoverState(previous, next);
      expect(taken.setlistPlayback).toEqual(
        buildPlayback({
          status: 'takenOver',
          itemId: ITEM_B,
          isFlashConfirmed: true,
        }),
      );
      expect(taken.setlistIndex).toBe(1);
      expect(taken.liveClipId).toBe(CLIP_ID);
    }
  });

  it('takes over when shuffle goes from off to on', () => {
    const previous = buildPlayingState();
    const next = { ...previous, shuffle: buildShuffle({ isOn: true }) };
    expect(vjSetlistTakeoverState(previous, next).setlistPlayback.status).toBe(
      'takenOver',
    );
    const alreadyOn = buildPlayingState({
      shuffle: buildShuffle({ isOn: true }),
    });
    expect(vjSetlistTakeoverState(alreadyOn, alreadyOn)).toBe(alreadyOn);
  });

  it('leaves manual, takenOver and finished alone, and a change that moves nothing', () => {
    for (const status of ['manual', 'takenOver', 'finished'] as const) {
      const previous = buildSequenceState(status);
      const next = { ...previous, liveClipId: CLIP_ID };
      expect(vjSetlistTakeoverState(previous, next)).toBe(next);
    }
    const playing = buildPlayingState();
    const sameSource = {
      ...playing,
      effects: { ...playing.effects, isBlackout: true },
    };
    expect(vjSetlistTakeoverState(playing, sameSource)).toBe(sameSource);
  });

  it('sets Loop only on the active set list', () => {
    const state = buildSequenceState('manual');
    expect(
      vjSetlistLoopingState(state, SETLIST_ID, true).setlistPlayback.isLooping,
    ).toBe(true);
    expect(
      vjSetlistLoopingState(state, SETLIST_ID.toUpperCase(), true)
        .setlistPlayback.isLooping,
    ).toBe(true);
    expect(vjSetlistLoopingState(state, OTHER_SETLIST_ID, true)).toBe(state);
    const idle = buildState();
    expect(vjSetlistLoopingState(idle, SETLIST_ID, true)).toBe(idle);
  });

  it('answers the same state when Loop already has the asked value', () => {
    const looping = buildSequenceState('manual', { isLooping: true });
    expect(vjSetlistLoopingState(looping, SETLIST_ID, true)).toBe(looping);
    const notLooping = buildSequenceState('manual', { isLooping: false });
    expect(vjSetlistLoopingState(notLooping, SETLIST_ID, false)).toBe(
      notLooping,
    );
  });

  it('clears the set list and its playback', () => {
    const cleared = vjSetlistClearedState(buildPlayingState());
    expect(cleared.activeSetlistId).toBeNull();
    expect(cleared.setlistIndex).toBeNull();
    expect(cleared.setlistPlayback).toEqual(createVjSetlistPlayback(false));
  });
});

describe('vj sequences: index follow', () => {
  const OLD_IDS = [ITEM_A, ITEM_B, ITEM_C, ITEM_D];

  function followed(
    onScreen: { index: number | null; itemId: string | null },
    nextIds: string[],
    previousItemIds: readonly string[] | null = OLD_IDS,
    isLooping = false,
  ): VjStageState {
    const state = buildPlayingState(
      { setlistIndex: onScreen.index },
      { itemId: onScreen.itemId },
    );
    return vjSetlistFollowState(state, {
      setlistId: SETLIST_ID,
      previousItemIds,
      read: { itemIds: nextIds, isLooping },
    });
  }

  it('follows the worked cases of the contract', () => {
    const cases: Array<{
      name: string;
      onScreen: { index: number | null; itemId: string | null };
      previous?: readonly string[];
      nextIds: string[];
      index: number | null;
      itemId: string | null;
    }> = [
      {
        name: 'move C first',
        onScreen: { index: 2, itemId: ITEM_C },
        nextIds: [ITEM_C, ITEM_A, ITEM_B, ITEM_D],
        index: 0,
        itemId: ITEM_C,
      },
      {
        name: 'remove A',
        onScreen: { index: 2, itemId: ITEM_C },
        nextIds: [ITEM_B, ITEM_C, ITEM_D],
        index: 1,
        itemId: ITEM_C,
      },
      {
        name: 'remove C',
        onScreen: { index: 2, itemId: ITEM_C },
        nextIds: [ITEM_A, ITEM_B, ITEM_D],
        index: 1,
        itemId: null,
      },
      {
        name: 'remove B and C',
        onScreen: { index: 2, itemId: ITEM_C },
        nextIds: [ITEM_A, ITEM_D],
        index: 0,
        itemId: null,
      },
      {
        name: 'remove A while on A',
        onScreen: { index: 0, itemId: ITEM_A },
        nextIds: [ITEM_B, ITEM_C, ITEM_D],
        index: null,
        itemId: null,
      },
      {
        name: 'insert X after C',
        onScreen: { index: 2, itemId: ITEM_C },
        nextIds: [ITEM_A, ITEM_B, ITEM_C, ITEM_X, ITEM_D],
        index: 2,
        itemId: ITEM_C,
      },
      {
        name: 'insert X after A with the item id gone',
        onScreen: { index: 0, itemId: null },
        previous: [ITEM_A, ITEM_C, ITEM_D],
        nextIds: [ITEM_A, ITEM_X, ITEM_C, ITEM_D],
        index: 0,
        itemId: null,
      },
      {
        name: 'scene of C deleted',
        onScreen: { index: 2, itemId: ITEM_C },
        nextIds: [ITEM_A, ITEM_B, ITEM_D],
        index: 1,
        itemId: null,
      },
    ];
    for (const testCase of cases) {
      const state = followed(
        testCase.onScreen,
        testCase.nextIds,
        testCase.previous ?? OLD_IDS,
      );
      expect([testCase.name, state.setlistIndex]).toEqual([
        testCase.name,
        testCase.index,
      ]);
      expect([testCase.name, state.setlistPlayback.itemId]).toEqual([
        testCase.name,
        testCase.itemId,
      ]);
    }
  });

  it('goes manual with no index and no clock when every step is removed', () => {
    const state = followed({ index: 2, itemId: ITEM_C }, []);
    expect(state.setlistIndex).toBeNull();
    expect(state.setlistPlayback).toEqual(
      buildPlayback({ status: 'manual', itemId: null }),
    );
  });

  it('keeps status and a running clock through an edit', () => {
    const state = followed({ index: 2, itemId: ITEM_C }, [
      ITEM_A,
      ITEM_B,
      ITEM_D,
    ]);
    expect(state.setlistPlayback).toEqual(
      buildPlayback({
        status: 'playing',
        itemId: null,
        stepStartedAt: NOW,
        stepEndsAt: NOW + 8000,
        stepDurationMs: 8000,
      }),
    );
  });

  it('copies the saved Loop into the playback', () => {
    const state = followed(
      { index: 2, itemId: ITEM_C },
      OLD_IDS,
      OLD_IDS,
      true,
    );
    expect(state.setlistPlayback.isLooping).toBe(true);
    expect(state.setlistIndex).toBe(2);
  });

  it('leaves the index null when nothing was on screen yet', () => {
    const state = followed({ index: null, itemId: null }, [ITEM_B, ITEM_A]);
    expect(state.setlistIndex).toBeNull();
    expect(state.setlistPlayback.itemId).toBeNull();
  });

  it('anchors on the old list when the item id is null (rules 6 and 7)', () => {
    const kept = followed({ index: 1, itemId: null }, [ITEM_C, ITEM_B, ITEM_A]);
    expect(kept.setlistIndex).toBe(1);
    const removed = followed({ index: 2, itemId: null }, [ITEM_A, ITEM_B]);
    expect(removed.setlistIndex).toBe(1);
    const firstRemoved = followed({ index: 0, itemId: null }, [ITEM_B, ITEM_C]);
    expect(firstRemoved.setlistIndex).toBeNull();
  });

  it('clamps when the old list is unknown and the step id is gone (rule 8)', () => {
    expect(
      followed({ index: 2, itemId: ITEM_C }, [ITEM_A, ITEM_B], null)
        .setlistIndex,
    ).toBe(1);
    expect(
      followed({ index: 0, itemId: ITEM_C }, [ITEM_A, ITEM_B], null)
        .setlistIndex,
    ).toBeNull();
    expect(
      followed({ index: 3, itemId: ITEM_X }, [ITEM_A, ITEM_B], OLD_IDS)
        .setlistIndex,
    ).toBe(1);
    expect(
      followed({ index: 3, itemId: ITEM_X }, [ITEM_A, ITEM_B], OLD_IDS)
        .setlistPlayback.itemId,
    ).toBeNull();
  });

  it('clamps when the old list is unknown or too short and the item id is null (rule 9)', () => {
    expect(
      followed({ index: 3, itemId: null }, [ITEM_A, ITEM_B], null).setlistIndex,
    ).toBe(1);
    expect(
      followed(
        { index: 2, itemId: null },
        [ITEM_A, ITEM_B, ITEM_C, ITEM_D],
        [ITEM_A],
      ).setlistIndex,
    ).toBe(2);
  });

  it('answers the same state for another set list and for a change that moves nothing', () => {
    const state = buildPlayingState();
    expect(
      vjSetlistFollowState(state, {
        setlistId: OTHER_SETLIST_ID,
        previousItemIds: OLD_IDS,
        read: { itemIds: [], isLooping: true },
      }),
    ).toBe(state);
    expect(
      vjSetlistFollowState(state, {
        setlistId: SETLIST_ID,
        previousItemIds: OLD_IDS,
        read: { itemIds: OLD_IDS, isLooping: false },
      }),
    ).toBe(state);
    const idle = buildState();
    expect(
      vjSetlistFollowState(idle, {
        setlistId: SETLIST_ID,
        previousItemIds: null,
        read: null,
      }),
    ).toBe(idle);
  });

  it('clears the set list when it is gone', () => {
    const state = buildPlayingState();
    expect(
      vjSetlistFollowState(state, {
        setlistId: SETLIST_ID,
        previousItemIds: OLD_IDS,
        read: null,
      }),
    ).toEqual(vjSetlistClearedState(state));
  });
});

describe('vj sequences: clock stamp and timer landing', () => {
  it('keeps the playback for a keep stamp', () => {
    const playback = buildPlayback({ status: 'paused', pausedRemainingMs: 5 });
    expect(stampVjSetlistClock(playback, { kind: 'keep' }, NOW)).toBe(playback);
  });

  it('clears only the two times for a clear stamp', () => {
    const playback = buildPlayback({
      status: 'paused',
      stepStartedAt: 1,
      stepEndsAt: 2,
      stepDurationMs: 8000,
      pausedRemainingMs: 5000,
    });
    expect(stampVjSetlistClock(playback, { kind: 'clear' }, NOW)).toEqual({
      ...playback,
      stepStartedAt: null,
      stepEndsAt: null,
    });
  });

  it('stamps a start from the change time', () => {
    const playback = buildPlayback({
      status: 'playing',
      pausedRemainingMs: 5000,
    });
    expect(
      stampVjSetlistClock(
        playback,
        { kind: 'start', durationMs: 8000, remainingMs: 5000 },
        10_000,
      ),
    ).toEqual({
      ...playback,
      stepStartedAt: 7000,
      stepEndsAt: 15_000,
      stepDurationMs: 8000,
      pausedRemainingMs: null,
    });
    const full = stampVjSetlistClock(
      playback,
      { kind: 'start', durationMs: 8000, remainingMs: 8000 },
      10_000,
    );
    expect(full.stepEndsAt).toBe(18_000);
    expect((full.stepEndsAt ?? 0) - (full.stepStartedAt ?? 0)).toBe(8000);
  });

  it('lands at the step end with quantize off, and not once it has passed', () => {
    const tempo = buildTempo({ quantize: 'off' });
    expect(vjSetlistAdvanceApplyAt(tempo, 20_000, 15_000)).toBe(20_000);
    expect(vjSetlistAdvanceApplyAt(tempo, 20_000, 20_000)).toBeNull();
    expect(vjSetlistAdvanceApplyAt(tempo, 20_000, 25_000)).toBeNull();
  });

  it('lands on the first beat boundary at or after the step end with quantize on', () => {
    const tempo = buildTempo({
      bpm: 120,
      downbeatAt: 10_000,
      quantize: 'beat',
    });
    expect(vjSetlistAdvanceApplyAt(tempo, 20_000, 15_000)).toBe(20_000);
    expect(vjSetlistAdvanceApplyAt(tempo, 20_001, 15_000)).toBe(20_000);
    expect(vjSetlistAdvanceApplyAt(tempo, 20_100, 15_000)).toBe(20_500);
  });

  it('lands on the next bar with quantize bar', () => {
    const tempo = buildTempo({ bpm: 120, downbeatAt: 10_000, quantize: 'bar' });
    expect(vjSetlistAdvanceApplyAt(tempo, 20_000, 15_000)).toBe(20_000);
    expect(vjSetlistAdvanceApplyAt(tempo, 20_100, 15_000)).toBe(22_000);
  });

  it('keeps the minimum lead from now when the step end is already close', () => {
    const tempo = buildTempo({
      bpm: 120,
      downbeatAt: 10_000,
      quantize: 'beat',
    });
    expect(vjSetlistAdvanceApplyAt(tempo, 20_000, 19_900)).toBe(20_500);
    expect(vjSetlistAdvanceApplyAt(tempo, 20_000, 30_000)).toBe(30_500);
  });
});

describe('vj sequences: restored playback', () => {
  const restoreInput = (
    overrides: Partial<VjSetlistRestoreInput> = {},
  ): VjSetlistRestoreInput => ({
    read: buildRead(buildSceneStep(1), { isLooping: true }),
    setlistIndex: 1,
    now: NOW,
    ...overrides,
  });

  it('answers the default playback when no set list is restored', () => {
    expect(
      restoredVjSetlistPlayback(
        buildPlayback({ status: 'playing' }),
        restoreInput({ read: null, setlistIndex: null }),
      ),
    ).toEqual(createVjSetlistPlayback(false));
  });

  it('reads an unknown status or a non-record as manual', () => {
    for (const value of [{ status: 'dancing' }, null, 'playing', 7, []]) {
      expect(restoredVjSetlistPlayback(value, restoreInput())).toEqual(
        buildPlayback({ status: 'manual', itemId: ITEM_B, isLooping: true }),
      );
    }
  });

  it('never restores the flash confirmation, and takes Loop and the item id from the read', () => {
    const restored = restoredVjSetlistPlayback(
      buildPlayback({
        status: 'manual',
        isFlashConfirmed: true,
        isLooping: false,
        itemId: ITEM_D,
      }),
      restoreInput(),
    );
    expect(restored.isFlashConfirmed).toBe(false);
    expect(restored.isLooping).toBe(true);
    expect(restored.itemId).toBe(ITEM_B);
    expect(
      restoredVjSetlistPlayback(
        buildPlayback({ status: 'manual' }),
        restoreInput({ setlistIndex: null }),
      ).itemId,
    ).toBeNull();
    expect(
      restoredVjSetlistPlayback(
        buildPlayback({ status: 'manual' }),
        restoreInput({ read: buildRead(null), setlistIndex: 1 }),
      ).itemId,
    ).toBeNull();
  });

  it('keeps the clock of a playing record, even a passed step end', () => {
    const playing = buildPlayback({
      status: 'playing',
      stepStartedAt: NOW - 3000,
      stepEndsAt: NOW + 5000,
      stepDurationMs: 8000,
    });
    expect(restoredVjSetlistPlayback(playing, restoreInput())).toEqual({
      ...playing,
      itemId: ITEM_B,
      isLooping: true,
    });
    const passed = buildPlayback({
      status: 'playing',
      stepStartedAt: NOW - 9000,
      stepEndsAt: NOW - 1000,
      stepDurationMs: 8000,
    });
    expect(restoredVjSetlistPlayback(passed, restoreInput()).status).toBe(
      'playing',
    );
    expect(restoredVjSetlistPlayback(passed, restoreInput()).stepEndsAt).toBe(
      NOW - 1000,
    );
  });

  it('keeps a playing step end exactly 600000 ms ahead of now', () => {
    const playing = buildPlayback({
      status: 'playing',
      stepStartedAt: NOW + 600_000 - 8000,
      stepEndsAt: NOW + 600_000,
      stepDurationMs: 8000,
    });
    const restored = restoredVjSetlistPlayback(playing, restoreInput());
    expect(restored.status).toBe('playing');
    expect(restored.stepEndsAt).toBe(NOW + 600_000);
  });

  it('restores a playing record that fails its check as manual with no clock', () => {
    const failing: Array<Record<string, unknown>> = [
      { stepStartedAt: NOW, stepEndsAt: NOW + 8000, stepDurationMs: 7999 },
      { stepStartedAt: NOW, stepEndsAt: NOW + 8000, stepDurationMs: 0 },
      {
        stepStartedAt: NOW,
        stepEndsAt: NOW + 700_000,
        stepDurationMs: 700_000,
      },
      {
        stepStartedAt: NOW + 700_000 - 8000,
        stepEndsAt: NOW + 700_000,
        stepDurationMs: 8000,
      },
      {
        stepStartedAt: NOW + 0.5,
        stepEndsAt: NOW + 8000.5,
        stepDurationMs: 8000,
      },
      { stepStartedAt: null, stepEndsAt: null, stepDurationMs: null },
      { stepStartedAt: '1', stepEndsAt: '2', stepDurationMs: 1 },
    ];
    for (const fields of failing) {
      expect(
        restoredVjSetlistPlayback(
          { ...buildPlayback({ status: 'playing' }), ...fields },
          restoreInput(),
        ),
      ).toEqual(
        buildPlayback({ status: 'manual', itemId: ITEM_B, isLooping: true }),
      );
    }
  });

  it('keeps the length and time left of a paused record', () => {
    const paused = buildPlayback({
      status: 'paused',
      stepDurationMs: 8000,
      pausedRemainingMs: 3000,
    });
    expect(restoredVjSetlistPlayback(paused, restoreInput())).toEqual({
      ...paused,
      itemId: ITEM_B,
      isLooping: true,
    });
    expect(
      restoredVjSetlistPlayback(
        { ...paused, pausedRemainingMs: 0 },
        restoreInput(),
      ).status,
    ).toBe('paused');
  });

  it('restores a paused record that fails its check as manual with no clock', () => {
    const failing: Array<Record<string, unknown>> = [
      { stepDurationMs: 8000, pausedRemainingMs: 8001 },
      { stepDurationMs: 8000, pausedRemainingMs: -1 },
      { stepDurationMs: 600_001, pausedRemainingMs: 1 },
      { stepDurationMs: 8000.5, pausedRemainingMs: 1 },
      { stepDurationMs: 8000, pausedRemainingMs: null },
      { stepDurationMs: null, pausedRemainingMs: 1 },
    ];
    for (const fields of failing) {
      expect(
        restoredVjSetlistPlayback(
          { ...buildPlayback({ status: 'paused' }), ...fields },
          restoreInput(),
        ),
      ).toEqual(
        buildPlayback({ status: 'manual', itemId: ITEM_B, isLooping: true }),
      );
    }
  });

  it('restores the other statuses with only a valid step length', () => {
    for (const status of [
      'manual',
      'takenOver',
      'finished',
      'needsFlashConsent',
    ] as const) {
      const record = buildPlayback({
        status,
        stepStartedAt: NOW,
        stepEndsAt: NOW + 8000,
        stepDurationMs: 8000,
        pausedRemainingMs: 100,
      });
      expect(restoredVjSetlistPlayback(record, restoreInput())).toEqual(
        buildPlayback({
          status,
          itemId: ITEM_B,
          isLooping: true,
          stepDurationMs: 8000,
        }),
      );
      for (const stepDurationMs of [0, 600_001, 1.5, null, '8000']) {
        expect(
          restoredVjSetlistPlayback(
            { ...record, stepDurationMs },
            restoreInput(),
          ).stepDurationMs,
        ).toBeNull();
      }
    }
  });
});
