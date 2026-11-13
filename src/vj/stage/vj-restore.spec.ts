import {
  createVjSetlistPlayback,
  createVjStageState,
  VJ_LIMITS,
  type VjEffectId,
  type VjSetlistRead,
  type VjSetlistReadPosition,
  type VjStageState,
} from '../vj.contract';
import {
  EMPTY_VJ_LOOKUP_RESULTS,
  vjSetlistItemKey,
  type VjLookupResults,
} from './vj-rule-kit';
import {
  restoredVjStageState,
  vjRestoreLookups,
  vjRestoreSetlistRead,
} from './vj-restore';

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

function itemIdAt(index: number): string {
  return `88888888-8888-4888-8888-${String(index).padStart(12, '0')}`;
}

/** The set list read at `position` of a list with `itemCount` clip steps. */
function setlistReadAt(
  itemCount: number,
  position: VjSetlistReadPosition,
  isLooping = false,
): VjSetlistRead {
  const itemIds = Array.from({ length: itemCount }, (_, index) =>
    itemIdAt(index),
  );
  const index = position.kind === 'index' ? position.index : null;
  return {
    setlistId: SETLIST_ID,
    isLooping,
    stepDuration: { kind: 'seconds', value: 8 },
    itemIds,
    step:
      index === null || index >= itemCount
        ? null
        : {
            kind: 'clip',
            itemId: itemIdAt(index),
            index,
            clipId: CLIP_ID,
            duration: { kind: 'seconds', value: 8 },
          },
  };
}

function atIndex(index: number): VjSetlistReadPosition {
  return { kind: 'index', index, wrapsToFirst: false };
}

/** The answer the resolver keys for one restore read. */
function setlistReads(
  itemCount: number,
  position: VjSetlistReadPosition = atIndex(2),
  isLooping = false,
): VjLookupResults['setlistItems'] {
  return new Map([
    [
      vjSetlistItemKey(SETLIST_ID, position),
      setlistReadAt(itemCount, position, isLooping),
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
  it('lists the pack, live clip, mix clip, excluded clips and the set list at the sent index', () => {
    expect(vjRestoreLookups(v2Restore(), NOW)).toEqual([
      { kind: 'pack', packId: PACK_ID },
      { kind: 'clip', clipId: CLIP_ID },
      { kind: 'clip', clipId: MIX_CLIP_ID },
      { kind: 'clipsInPack', packId: PACK_ID, clipIds: [EXCLUDED_CLIP_ID] },
      { kind: 'setlistItem', setlistId: SETLIST_ID, position: atIndex(2) },
    ]);
  });

  it('reads the item count only for an index a set list cannot hold', () => {
    for (const setlistIndex of [
      null,
      -1,
      1.5,
      '2',
      VJ_LIMITS.setlistItemsMax,
    ]) {
      const lookups = vjRestoreLookups(
        { activeSetlistId: SETLIST_ID.toUpperCase(), setlistIndex },
        NOW,
      );
      expect(lookups).toEqual([
        {
          kind: 'setlistItem',
          setlistId: SETLIST_ID,
          position: { kind: 'count' },
        },
      ]);
    }
    expect(
      vjRestoreLookups(
        {
          activeSetlistId: SETLIST_ID,
          setlistIndex: VJ_LIMITS.setlistItemsMax - 1,
        },
        NOW,
      ),
    ).toEqual([
      {
        kind: 'setlistItem',
        setlistId: SETLIST_ID,
        position: atIndex(VJ_LIMITS.setlistItemsMax - 1),
      },
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
      { ...allFoundReads(), setlistItems: setlistReads(4, atIndex(4)) },
      NOW,
    );
    expect(atCount.activeSetlistId).toBe(SETLIST_ID);
    expect(atCount.setlistIndex).toBeNull();
    expect(atCount.setlistPlayback.itemId).toBeNull();
    const notInteger = restoredVjStageState(
      baseState(),
      v2Restore({ setlistIndex: 1.5 }),
      { ...allFoundReads(), setlistItems: setlistReads(4, { kind: 'count' }) },
      NOW,
    );
    expect(notInteger.activeSetlistId).toBe(SETLIST_ID);
    expect(notInteger.setlistIndex).toBeNull();
    const lastItem = restoredVjStageState(
      baseState(),
      v2Restore({ setlistIndex: 3 }),
      { ...allFoundReads(), setlistItems: setlistReads(4, atIndex(3)) },
      NOW,
    );
    expect(lastItem.setlistIndex).toBe(3);
    expect(lastItem.setlistPlayback.itemId).toBe(itemIdAt(3));
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

describe('restore of the set list playback', () => {
  /** A restore of the v2 payload with the playback given and the set list
   *  read at index 2 of four steps. */
  function restoreWith(
    setlistPlayback: unknown,
    isLooping = true,
    overrides: Record<string, unknown> = {},
  ): VjStageState {
    return restoredVjStageState(
      baseState(),
      v2Restore({ setlistPlayback, ...overrides }),
      {
        ...allFoundReads(),
        setlistItems: setlistReads(4, atIndex(2), isLooping),
      },
      NOW,
    );
  }

  it('keeps a running clock that checks out, a past step end included', () => {
    const running = {
      status: 'playing',
      itemId: 'stale-id',
      isFlashConfirmed: true,
      stepStartedAt: NOW - 3000,
      stepEndsAt: NOW + 5000,
      stepDurationMs: 8000,
      pausedRemainingMs: null,
      isLooping: false,
    };
    const restored = restoreWith(running);
    expect(restored.setlistIndex).toBe(2);
    expect(restored.setlistPlayback).toEqual({
      status: 'playing',
      itemId: itemIdAt(2),
      isFlashConfirmed: false,
      stepStartedAt: NOW - 3000,
      stepEndsAt: NOW + 5000,
      stepDurationMs: 8000,
      pausedRemainingMs: null,
      isLooping: true,
    });

    const passed = restoreWith({
      ...running,
      stepStartedAt: NOW - 20_000,
      stepEndsAt: NOW - 12_000,
    });
    expect(passed.setlistPlayback.status).toBe('playing');
    expect(passed.setlistPlayback.stepEndsAt).toBe(NOW - 12_000);
  });

  it('restores a running clock that does not check out as manual with no clock', () => {
    const running = {
      status: 'playing',
      stepStartedAt: NOW - 3000,
      stepEndsAt: NOW + 5000,
      stepDurationMs: 8000,
    };
    for (const broken of [
      { ...running, stepDurationMs: 7000 },
      { ...running, stepDurationMs: 0, stepStartedAt: NOW + 5000 },
      { ...running, stepEndsAt: NOW + 700_000, stepStartedAt: NOW + 692_000 },
      { ...running, stepStartedAt: null },
      { ...running, stepDurationMs: 700_000, stepStartedAt: NOW - 695_000 },
    ]) {
      expect(restoreWith(broken).setlistPlayback).toEqual({
        ...createVjSetlistPlayback(true),
        itemId: itemIdAt(2),
      });
    }
  });

  it('keeps a paused step whose time left checks out', () => {
    const paused = {
      status: 'paused',
      stepDurationMs: 8000,
      pausedRemainingMs: 2500,
    };
    expect(restoreWith(paused).setlistPlayback).toEqual({
      ...createVjSetlistPlayback(true),
      status: 'paused',
      itemId: itemIdAt(2),
      stepDurationMs: 8000,
      pausedRemainingMs: 2500,
    });
    expect(
      restoreWith({ ...paused, pausedRemainingMs: 9000 }).setlistPlayback
        .status,
    ).toBe('manual');
    expect(
      restoreWith({ ...paused, pausedRemainingMs: -1 }).setlistPlayback,
    ).toEqual({ ...createVjSetlistPlayback(true), itemId: itemIdAt(2) });
  });

  it('restores the other statuses with no clock and a valid length kept', () => {
    for (const status of [
      'manual',
      'takenOver',
      'finished',
      'needsFlashConsent',
    ]) {
      const restored = restoreWith({
        status,
        stepStartedAt: NOW,
        stepEndsAt: NOW + 8000,
        stepDurationMs: 8000,
        pausedRemainingMs: 100,
        isFlashConfirmed: true,
      });
      expect(restored.setlistPlayback).toEqual({
        ...createVjSetlistPlayback(true),
        status,
        itemId: itemIdAt(2),
        stepDurationMs: 8000,
      });
    }
    expect(
      restoreWith({ status: 'finished', stepDurationMs: 1.5 }).setlistPlayback
        .stepDurationMs,
    ).toBeNull();
    expect(restoreWith({ status: 'dancing' }).setlistPlayback.status).toBe(
      'manual',
    );
  });

  it('fills the default playback for a snapshot saved before sequences', () => {
    const beforeSequences = v2Restore();
    expect('setlistPlayback' in beforeSequences).toBe(false);
    expect(beforeSequences.activeSetlistId).toBe(SETLIST_ID);
    const restored = restoredVjStageState(
      baseState(),
      beforeSequences,
      {
        ...allFoundReads(),
        setlistItems: setlistReads(4, atIndex(2), true),
      },
      NOW,
    );
    expect(restored.activeSetlistId).toBe(SETLIST_ID);
    expect(restored.setlistIndex).toBe(2);
    expect(restored.setlistPlayback).toEqual({
      ...createVjSetlistPlayback(true),
      itemId: itemIdAt(2),
    });
    const sentUndefined = restoreWith(undefined, false);
    expect(sentUndefined.setlistPlayback).toEqual({
      ...createVjSetlistPlayback(false),
      itemId: itemIdAt(2),
    });
    const v1 = restoredVjStageState(
      baseState(),
      { activePackId: PACK_ID, transition: { mode: 'cut', fadeMs: 400 } },
      allFoundReads(),
      NOW,
    );
    expect(v1.setlistPlayback).toEqual(createVjSetlistPlayback(false));
  });

  it('restores the default playback with no set list or a set list the read did not find', () => {
    const running = {
      status: 'playing',
      stepStartedAt: NOW - 3000,
      stepEndsAt: NOW + 5000,
      stepDurationMs: 8000,
    };
    const gone = restoredVjStageState(
      baseState(),
      v2Restore({ setlistPlayback: running }),
      {
        ...allFoundReads(),
        setlistItems: new Map([
          [vjSetlistItemKey(SETLIST_ID, atIndex(2)), null],
        ]),
      },
      NOW,
    );
    expect(gone.activeSetlistId).toBeNull();
    expect(gone.setlistIndex).toBeNull();
    expect(gone.setlistPlayback).toEqual(createVjSetlistPlayback(false));

    const none = restoreWith(running, true, { activeSetlistId: null });
    expect(none.activeSetlistId).toBeNull();
    expect(none.setlistPlayback).toEqual(createVjSetlistPlayback(false));
  });

  it('nulls the item id with the index when the index is out of range', () => {
    const restored = restoredVjStageState(
      baseState(),
      v2Restore({
        setlistIndex: 7,
        setlistPlayback: { status: 'takenOver', stepDurationMs: 8000 },
      }),
      { ...allFoundReads(), setlistItems: setlistReads(4, atIndex(7)) },
      NOW,
    );
    expect(restored.setlistIndex).toBeNull();
    expect(restored.setlistPlayback).toEqual({
      ...createVjSetlistPlayback(false),
      status: 'takenOver',
      stepDurationMs: 8000,
    });
  });

  it('hands back the set list read the restore listed, for the stage item ids', () => {
    const reads = allFoundReads();
    const read = vjRestoreSetlistRead(v2Restore(), reads, NOW);
    expect(read?.itemIds).toEqual([0, 1, 2, 3].map(itemIdAt));
    expect(read?.step?.index).toBe(2);
    expect(
      vjRestoreSetlistRead(v2Restore({ activeSetlistId: null }), reads, NOW),
    ).toBeNull();
    expect(vjRestoreSetlistRead(v2Restore(), readsOf(), NOW)).toBeNull();
    expect(vjRestoreSetlistRead('state', reads, NOW)).toBeNull();
  });
});
