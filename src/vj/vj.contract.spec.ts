import {
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
  VJ_SERVER_FRAME_NAMES,
  VJ_SOCKET_ERROR_CODES,
  VJ_SPEEDS,
  VJ_STAGE_CAUSES,
  VJ_TRANSITION_CATALOG,
  VJ_TRANSITION_IDS,
  canonicalVjStageState,
  createVjStageState,
  isSameVjStageContent,
  roundVjAmount,
  upgradeVjStageFieldsV1,
  vjBeatPositionAt,
  vjBlackoutFadeMs,
  vjClockOffsetMs,
  vjEffectSettingOf,
  vjIsQuantizedChange,
  vjLastDownbeatAt,
  vjNextBoundaryAt,
  vjQuantizedApplyAt,
  vjSceneLookOf,
  vjShuffleIntervalMs,
  vjStrobeFlashesPerSecond,
  vjTransitionLengthMs,
  type VjClockSample,
  type VjEffectId,
  type VjShuffle,
  type VjStageState,
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
    ]);
  });

  it('lists the catalog in catalog order with a catalog entry per id', () => {
    expect(Object.keys(VJ_EFFECT_CATALOG)).toEqual([...VJ_EFFECT_IDS]);
    expect(VJ_EFFECT_IDS).toHaveLength(34);
    for (const effectId of VJ_EFFECT_IDS) {
      const entry = VJ_EFFECT_CATALOG[effectId];
      expect(entry.defaultVariant).toBe(
        entry.variants.length === 0 ? null : entry.variants[0],
      );
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
      'stage:setCountdown',
      'stage:setLogo',
      'stage:setEventCard',
      'screen:identify',
      'screen:advance',
      'screen:status',
    ]);
    expect(VJ_SERVER_FRAME_NAMES).toEqual([
      'stage:state',
      'screen:role',
      'screens:update',
      'library:changed',
      'screen:identify',
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
      'stage:setCountdown',
      'stage:setLogo',
      'stage:setEventCard',
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
      'clip_favorite_changed',
      'clip_defaults_changed',
      'clip_preview_changed',
      'pack_event_changed',
      'scene_created',
      'scene_updated',
      'scene_deleted',
      'scenes_reordered',
      'setlist_created',
      'setlist_renamed',
      'setlist_items_changed',
      'setlist_deleted',
      'setlists_reordered',
    ]);
    expect(VJ_SOCKET_ERROR_CODES).toHaveLength(72);
    expect(new Set(VJ_SOCKET_ERROR_CODES).size).toBe(72);
    expect(VJ_SOCKET_ERROR_CODES[0]).toBe('vj_not_admin');
    expect(VJ_SOCKET_ERROR_CODES[VJ_SOCKET_ERROR_CODES.length - 1]).toBe(
      'vj_server_error',
    );
    const bpmIndex = VJ_SOCKET_ERROR_CODES.indexOf('vj_bpm_out_of_range');
    expect(VJ_SOCKET_ERROR_CODES[bpmIndex + 1]).toBe('vj_client_outdated');
    expect(VJ_SOCKET_ERROR_CODES[VJ_SOCKET_ERROR_CODES.length - 2]).toBe(
      'vj_event_card_no_event',
    );
    expect(VJ_LIBRARY_CHANGED).toBe('vj.library.changed');
  });
});
