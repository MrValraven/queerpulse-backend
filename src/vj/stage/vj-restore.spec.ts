import {
  createVjStageState,
  VJ_LIMITS,
  type VjEffectId,
  type VjStageState,
} from '../vj.contract';
import {
  EMPTY_VJ_LOOKUP_RESULTS,
  vjSetlistItemKey,
  type VjLookupResults,
} from './vj-rule-kit';
import { restoredVjStageState, vjRestoreLookups } from './vj-restore';

const STAGE_EPOCH = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;
const PACK_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = '55555555-5555-4555-8555-555555555555';
const CLIP_ID = '22222222-2222-4222-8222-222222222222';
const MIX_CLIP_ID = '33333333-3333-4333-8333-333333333333';
const EXCLUDED_CLIP_ID = '66666666-6666-4666-8666-666666666666';
const SETLIST_ID = '77777777-7777-4777-8777-777777777777';

function baseState(): VjStageState {
  return createVjStageState(STAGE_EPOCH, NOW - 5_000);
}

function readsOf(parts: Partial<VjLookupResults> = {}): VjLookupResults {
  return { ...EMPTY_VJ_LOOKUP_RESULTS, ...parts };
}

function setlistReads(itemCount: number): VjLookupResults['setlistItems'] {
  return new Map([
    [
      vjSetlistItemKey(SETLIST_ID, null),
      {
        setlistId: SETLIST_ID,
        index: null,
        itemCount,
        sceneId: null,
        look: null,
      },
    ],
  ]);
}

/** A v2 restore payload with every field at a non-default, valid value. */
function v2Restore(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const defaults = createVjStageState(STAGE_EPOCH, NOW);
  return {
    stageEpoch: STAGE_EPOCH,
    revision: 42,
    activePackId: PACK_ID,
    liveClipId: CLIP_ID,
    liveGeneratorId: null,
    liveGeneratorVariant: null,
    transition: defaults.transition,
    overlay: defaults.overlay,
    countdown: defaults.countdown,
    logo: defaults.logo,
    eventCard: { isVisible: true, kind: 'nextEvent' },
    effects: defaults.effects,
    mix: { clipId: MIX_CLIP_ID, amount: 0.4, blendMode: 'screen' },
    tempo: {
      bpm: 128,
      downbeatAt: NOW - 90_000,
      quantize: 'bar',
      source: 'tap',
    },
    shuffle: {
      ...defaults.shuffle,
      excludedClipIds: [EXCLUDED_CLIP_ID],
    },
    activeSetlistId: SETLIST_ID,
    setlistIndex: 2,
    ...overrides,
  };
}

/** Reads that find every id the v2 payload names. */
function allFoundReads(): VjLookupResults {
  return readsOf({
    packs: new Map([[PACK_ID, { eventId: EVENT_ID }]]),
    existingClipIds: new Set([CLIP_ID, MIX_CLIP_ID]),
    clipIdsInPack: new Set([EXCLUDED_CLIP_ID]),
    setlistItems: setlistReads(4),
  });
}

describe('vjRestoreLookups', () => {
  it('lists the pack, live clip, mix clip, excluded clips and set list count reads', () => {
    expect(vjRestoreLookups(v2Restore(), NOW)).toEqual([
      { kind: 'pack', packId: PACK_ID },
      { kind: 'clip', clipId: CLIP_ID },
      { kind: 'clip', clipId: MIX_CLIP_ID },
      { kind: 'clipsInPack', packId: PACK_ID, clipIds: [EXCLUDED_CLIP_ID] },
      { kind: 'setlistItem', setlistId: SETLIST_ID, index: null },
    ]);
  });

  it('lowercases ids, skips ids that are no uuid and reads a v1 snapshot', () => {
    const lookups = vjRestoreLookups(
      {
        activePackId: PACK_ID.toUpperCase(),
        liveClipId: 'not-a-uuid',
        transition: { mode: 'fade', fadeMs: 800 },
      },
      NOW,
    );
    expect(lookups).toEqual([{ kind: 'pack', packId: PACK_ID }]);
  });

  it('answers no reads for a payload that is not an object', () => {
    expect(vjRestoreLookups(null, NOW)).toEqual([]);
    expect(vjRestoreLookups(['state'], NOW)).toEqual([]);
  });
});

describe('restoredVjStageState', () => {
  it('seeds a v2 stage from a v1 snapshot', () => {
    const v1Snapshot = {
      stageEpoch: STAGE_EPOCH,
      revision: 7,
      activePackId: PACK_ID,
      liveClipId: CLIP_ID,
      transition: { mode: 'cut', fadeMs: 400 },
      overlay: { text: 'Hello', style: 'ticker', isVisible: true },
      effects: {
        speed: 2,
        isMonochrome: true,
        isMirrored: false,
        isHueCycling: true,
        isStrobing: true,
        isBlackout: false,
        strobeStartedAt: NOW - 1_000,
      },
      shuffle: {
        isOn: true,
        intervalKind: 'seconds',
        intervalValue: 10,
        bpm: 128,
      },
    };
    const restored = restoredVjStageState(
      baseState(),
      v1Snapshot,
      readsOf({
        packs: new Map([[PACK_ID, { eventId: null }]]),
        existingClipIds: new Set([CLIP_ID]),
      }),
      NOW,
    );
    expect(restored).toMatchObject({
      stageEpoch: STAGE_EPOCH,
      revision: 1,
      clipSequence: 1,
      activePackId: PACK_ID,
      liveClipId: CLIP_ID,
      liveSince: NOW,
      transition: { mode: 'cut', length: { unit: 'ms', value: 400 } },
      overlay: {
        text: 'Hello',
        style: 'ticker',
        isVisible: true,
        position: 'bottom',
        size: 'l',
        colorToken: 'cream',
        hideAt: null,
      },
      effects: {
        speed: 2,
        settings: {
          monochrome: { isOn: true, amount: 1, variant: null },
          hueCycle: { isOn: true, amount: 0.5, variant: null },
        },
        isStrobing: false,
        strobeStartedAt: null,
      },
      tempo: { bpm: 128, downbeatAt: NOW, quantize: 'off', source: 'manual' },
      shuffle: {
        isOn: true,
        intervalKind: 'seconds',
        intervalValue: 10,
        source: 'pack',
        excludedClipIds: [],
      },
      recentClipIds: [CLIP_ID],
      updatedAt: NOW,
    });
    expect(restored.shuffle).not.toHaveProperty('bpm');
  });

  it('seeds the default tempo from a v1 bpm that is not finite', () => {
    const restored = restoredVjStageState(
      baseState(),
      {
        shuffle: {
          isOn: false,
          intervalKind: 'seconds',
          intervalValue: 8,
          bpm: null,
        },
      },
      readsOf(),
      NOW,
    );
    expect(restored.tempo.bpm).toBe(VJ_LIMITS.bpmDefault);
  });

  it('drops a missing pack, clip, mix clip or set list', () => {
    const restored = restoredVjStageState(
      baseState(),
      v2Restore(),
      readsOf(),
      NOW,
    );
    expect(restored.activePackId).toBeNull();
    expect(restored.liveClipId).toBeNull();
    expect(restored.liveSince).toBeNull();
    expect(restored.mix).toEqual({
      clipId: null,
      amount: 0,
      blendMode: 'screen',
    });
    expect(restored.shuffle.excludedClipIds).toEqual([]);
    expect(restored.activeSetlistId).toBeNull();
    expect(restored.setlistIndex).toBeNull();
    expect(restored.eventCard.isVisible).toBe(false);
  });

  it('keeps every id the reads found', () => {
    const restored = restoredVjStageState(
      baseState(),
      v2Restore(),
      allFoundReads(),
      NOW,
    );
    expect(restored.activePackId).toBe(PACK_ID);
    expect(restored.liveClipId).toBe(CLIP_ID);
    expect(restored.mix).toEqual({
      clipId: MIX_CLIP_ID,
      amount: 0.4,
      blendMode: 'screen',
    });
    expect(restored.shuffle.excludedClipIds).toEqual([EXCLUDED_CLIP_ID]);
    expect(restored.activeSetlistId).toBe(SETLIST_ID);
    expect(restored.setlistIndex).toBe(2);
  });

  it('restores a generator with its variant and the default variant for a bad one', () => {
    const generatorRestore = v2Restore({
      liveClipId: null,
      liveGeneratorId: 'prideFlagWave',
      liveGeneratorVariant: 'trans',
    });
    const restored = restoredVjStageState(
      baseState(),
      generatorRestore,
      readsOf(),
      NOW,
    );
    expect(restored.liveGeneratorId).toBe('prideFlagWave');
    expect(restored.liveGeneratorVariant).toBe('trans');
    expect(restored.liveSince).toBe(NOW);
    expect(restored.recentClipIds).toEqual([]);
    const badVariant = restoredVjStageState(
      baseState(),
      { ...generatorRestore, liveGeneratorVariant: 'unknown' },
      readsOf(),
      NOW,
    );
    expect(badVariant.liveGeneratorVariant).toBe('rainbow');
    const badGenerator = restoredVjStageState(
      baseState(),
      { ...generatorRestore, liveGeneratorId: 'lava' },
      readsOf(),
      NOW,
    );
    expect(badGenerator.liveGeneratorId).toBeNull();
    expect(badGenerator.liveSince).toBeNull();
  });

  it('keeps the first 8 effects and the first playhead effect', () => {
    const nineOn: VjEffectId[] = [
      'monochrome',
      'saturate',
      'contrast',
      'thermal',
      'hueCycle',
      'hueShift',
      'vhs',
      'filmGrain',
      'scanlines',
    ];
    const settings: Record<string, unknown> = {};
    for (const effectId of nineOn) {
      settings[effectId] = { isOn: true, amount: 0.7, variant: null };
    }
    const restored = restoredVjStageState(
      baseState(),
      v2Restore({
        effects: {
          speed: 1,
          settings,
          isStrobing: false,
          isBlackout: false,
          strobeStartedAt: null,
        },
      }),
      readsOf(),
      NOW,
    );
    const onIds = Object.entries(restored.effects.settings)
      .filter(([, setting]) => setting?.isOn === true)
      .map(([effectId]) => effectId);
    expect(onIds).toEqual(nineOn.slice(0, 8));
    expect(restored.effects.settings.scanlines?.isOn).toBe(false);

    const playheads = restoredVjStageState(
      baseState(),
      v2Restore({
        effects: {
          speed: 1,
          settings: {
            freeze: { isOn: true, amount: 1, variant: null },
            reverse: { isOn: true, amount: 1, variant: null },
            monochrome: 'broken',
          },
          isStrobing: true,
          isBlackout: true,
          strobeStartedAt: NOW,
        },
      }),
      readsOf(),
      NOW,
    );
    expect(playheads.effects.settings.freeze?.isOn).toBe(true);
    expect(playheads.effects.settings.reverse?.isOn ?? false).toBe(false);
    expect(playheads.effects.settings.monochrome).toBeUndefined();
    expect(playheads.effects.isStrobing).toBe(false);
    expect(playheads.effects.strobeStartedAt).toBeNull();
    expect(playheads.effects.isBlackout).toBe(true);
  });

  it('hides a stale overlay and a finished countdown', () => {
    const restored = restoredVjStageState(
      baseState(),
      v2Restore({
        overlay: {
          text: 'Doors close soon',
          style: 'big',
          isVisible: true,
          position: 'top',
          size: 'm',
          colorToken: 'cream',
          hideAt: NOW,
        },
        countdown: {
          isVisible: true,
          targetAt: NOW - VJ_LIMITS.countdownHoldMs,
          label: 'Show',
        },
      }),
      allFoundReads(),
      NOW,
    );
    expect(restored.overlay.isVisible).toBe(false);
    expect(restored.overlay.hideAt).toBeNull();
    expect(restored.overlay.position).toBe('top');
    expect(restored.countdown).toEqual({
      isVisible: false,
      targetAt: NOW - VJ_LIMITS.countdownHoldMs,
      label: 'Show',
    });

    const running = restoredVjStageState(
      baseState(),
      v2Restore({
        overlay: {
          text: 'Doors close soon',
          style: 'big',
          isVisible: true,
          position: 'top',
          size: 'm',
          colorToken: 'cream',
          hideAt: NOW + 1_000,
        },
        countdown: { isVisible: true, targetAt: NOW + 60_000, label: 'Show' },
      }),
      allFoundReads(),
      NOW,
    );
    expect(running.overlay.isVisible).toBe(true);
    expect(running.overlay.hideAt).toBe(NOW + 1_000);
    expect(running.countdown.isVisible).toBe(true);
  });

  it('shows the event card only for a pack that links an event', () => {
    const linked = restoredVjStageState(
      baseState(),
      v2Restore(),
      allFoundReads(),
      NOW,
    );
    expect(linked.eventCard).toEqual({ isVisible: true, kind: 'nextEvent' });
    const unlinked = restoredVjStageState(
      baseState(),
      v2Restore(),
      { ...allFoundReads(), packs: new Map([[PACK_ID, { eventId: null }]]) },
      NOW,
    );
    expect(unlinked.eventCard).toEqual({ isVisible: false, kind: 'nextEvent' });
  });

  it('nulls a set list index at or past the count', () => {
    const atCount = restoredVjStageState(
      baseState(),
      v2Restore({ setlistIndex: 4 }),
      allFoundReads(),
      NOW,
    );
    expect(atCount.activeSetlistId).toBe(SETLIST_ID);
    expect(atCount.setlistIndex).toBeNull();
    const notInteger = restoredVjStageState(
      baseState(),
      v2Restore({ setlistIndex: 1.5 }),
      allFoundReads(),
      NOW,
    );
    expect(notInteger.setlistIndex).toBeNull();
    const lastItem = restoredVjStageState(
      baseState(),
      v2Restore({ setlistIndex: 3 }),
      allFoundReads(),
      NOW,
    );
    expect(lastItem.setlistIndex).toBe(3);
  });

  it('keeps the tempo phase', () => {
    const restored = restoredVjStageState(
      baseState(),
      v2Restore(),
      allFoundReads(),
      NOW,
    );
    expect(restored.tempo).toEqual({
      bpm: 128,
      downbeatAt: NOW - 90_000,
      quantize: 'bar',
      source: 'tap',
    });
  });

  it('leaves overrides out and seeds history with the live clip', () => {
    const restored = restoredVjStageState(
      baseState(),
      v2Restore({
        screenOverrides: {
          [EXCLUDED_CLIP_ID]: {
            clipId: MIX_CLIP_ID,
            generatorId: null,
            generatorVariant: null,
          },
        },
        recentClipIds: [MIX_CLIP_ID, CLIP_ID],
        liveSince: NOW - 60_000,
        clipSequence: 99,
      }),
      allFoundReads(),
      NOW,
    );
    expect(restored.screenOverrides).toEqual({});
    expect(restored.recentClipIds).toEqual([CLIP_ID]);
    expect(restored.liveSince).toBe(NOW);
    expect(restored.revision).toBe(1);
    expect(restored.clipSequence).toBe(1);
  });

  it('answers the base state for a payload that is not an object', () => {
    const base = baseState();
    expect(restoredVjStageState(base, 'state', readsOf(), NOW)).toBe(base);
  });
});
