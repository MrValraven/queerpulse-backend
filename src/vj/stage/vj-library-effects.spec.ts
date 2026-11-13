import { buildVjLibraryChange } from '../vj-library-kit';
import {
  createVjSetlistPlayback,
  createVjStageState,
  type VjLibraryChange,
  type VjSetlistFollowRead,
  type VjSetlistPlayback,
  type VjStageState,
} from '../vj.contract';
import { vjLibraryChangeState } from './vj-library-effects';

const STAGE_EPOCH = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;
const PACK_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_PACK_ID = '88888888-8888-4888-8888-888888888888';
const CLIP_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_CLIP_ID = '33333333-3333-4333-8333-333333333333';
const SCREEN_ID = '99999999-9999-4999-8999-999999999999';
const OTHER_SCREEN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SETLIST_ID = '77777777-7777-4777-8777-777777777777';
const SCENE_ID = '66666666-6666-4666-8666-666666666666';
const EVENT_ID = '55555555-5555-4555-8555-555555555555';

const ITEM_A = 'b0000000-0000-4000-8000-00000000000a';
const ITEM_B = 'b0000000-0000-4000-8000-00000000000b';
const ITEM_C = 'b0000000-0000-4000-8000-00000000000c';
const ITEM_D = 'b0000000-0000-4000-8000-00000000000d';
const ITEM_X = 'b0000000-0000-4000-8000-0000000000ee';
const OLD_ITEM_IDS = [ITEM_A, ITEM_B, ITEM_C, ITEM_D];

const NO_READS: ReadonlyMap<string, VjSetlistFollowRead | null> = new Map();

/** `vjLibraryChangeState` at `NOW`. */
function libraryChangeStateAtNow(
  state: VjStageState,
  change: VjLibraryChange,
  setlistReads: ReadonlyMap<string, VjSetlistFollowRead | null>,
  previousItemIds: readonly string[] | null,
): VjStageState | null {
  return vjLibraryChangeState(
    state,
    change,
    setlistReads,
    previousItemIds,
    NOW,
  );
}

function stageState(overrides: Partial<VjStageState> = {}): VjStageState {
  const base = createVjStageState(STAGE_EPOCH, NOW);
  return {
    ...base,
    revision: 5,
    clipSequence: 3,
    activePackId: PACK_ID,
    liveClipId: CLIP_ID,
    liveSince: NOW - 10_000,
    eventCard: { isVisible: true, kind: 'qr' },
    mix: { clipId: CLIP_ID, amount: 0.6, blendMode: 'multiply' },
    shuffle: {
      ...base.shuffle,
      isOn: true,
      excludedClipIds: [CLIP_ID, OTHER_CLIP_ID],
    },
    recentClipIds: [CLIP_ID, OTHER_CLIP_ID],
    screenOverrides: {
      [SCREEN_ID]: {
        clipId: CLIP_ID,
        generatorId: null,
        generatorVariant: null,
      },
      [OTHER_SCREEN_ID]: {
        clipId: OTHER_CLIP_ID,
        generatorId: null,
        generatorVariant: null,
      },
    },
    activeSetlistId: SETLIST_ID,
    setlistIndex: 3,
    ...overrides,
  };
}

describe('vjLibraryChangeState', () => {
  it('clears the active pack, the shuffle, its exclusions and the event card on pack_deleted', () => {
    const state = stageState();
    const next = libraryChangeStateAtNow(
      state,
      buildVjLibraryChange('pack_deleted', { packId: PACK_ID.toUpperCase() }),
      NO_READS,
      null,
    );
    expect(next).toEqual({
      ...state,
      activePackId: null,
      clipSequence: 4,
      shuffle: { ...state.shuffle, isOn: false, excludedClipIds: [] },
      eventCard: { isVisible: false, kind: 'qr' },
    });
    expect(next?.liveClipId).toBe(CLIP_ID);
    expect(
      libraryChangeStateAtNow(
        state,
        buildVjLibraryChange('pack_deleted', { packId: OTHER_PACK_ID }),
        NO_READS,
        null,
      ),
    ).toBeNull();
  });

  it('clears the live clip, the mix, overrides, history and exclusions on clip_deleted', () => {
    const state = stageState();
    const next = libraryChangeStateAtNow(
      state,
      buildVjLibraryChange('clip_deleted', {
        clipId: CLIP_ID,
        packIds: [PACK_ID],
      }),
      NO_READS,
      null,
    );
    expect(next).toEqual({
      ...state,
      liveClipId: null,
      liveSince: null,
      clipSequence: 4,
      mix: { clipId: null, amount: 0, blendMode: 'multiply' },
      screenOverrides: {
        [OTHER_SCREEN_ID]: state.screenOverrides[OTHER_SCREEN_ID],
      },
      recentClipIds: [OTHER_CLIP_ID],
      shuffle: { ...state.shuffle, excludedClipIds: [OTHER_CLIP_ID] },
    });
  });

  it('keeps a live generator and the sequence when the deleted clip is only in the history', () => {
    const state = stageState({
      liveClipId: null,
      liveGeneratorId: 'plasma',
      mix: { clipId: null, amount: 0, blendMode: 'normal' },
      screenOverrides: {},
      shuffle: { ...stageState().shuffle, excludedClipIds: [] },
    });
    const next = libraryChangeStateAtNow(
      state,
      buildVjLibraryChange('clip_deleted', { clipId: CLIP_ID }),
      NO_READS,
      null,
    );
    expect(next).toEqual({ ...state, recentClipIds: [OTHER_CLIP_ID] });
    expect(next?.clipSequence).toBe(3);
    expect(next?.liveSince).toBe(NOW - 10_000);
  });

  it('hides the event card when the active pack unlinks its event', () => {
    const state = stageState();
    const next = libraryChangeStateAtNow(
      state,
      buildVjLibraryChange('pack_event_changed', {
        packId: PACK_ID,
        eventId: null,
      }),
      NO_READS,
      null,
    );
    expect(next).toEqual({
      ...state,
      eventCard: { isVisible: false, kind: 'qr' },
    });
    expect(
      libraryChangeStateAtNow(
        state,
        buildVjLibraryChange('pack_event_changed', {
          packId: PACK_ID,
          eventId: EVENT_ID,
        }),
        NO_READS,
        null,
      ),
    ).toBeNull();
    expect(
      libraryChangeStateAtNow(
        state,
        buildVjLibraryChange('pack_event_changed', {
          packId: OTHER_PACK_ID,
          eventId: null,
        }),
        NO_READS,
        null,
      ),
    ).toBeNull();
  });

  it('leaves stale excluded ids after pack_clips_changed', () => {
    const state = stageState();
    expect(
      libraryChangeStateAtNow(
        state,
        buildVjLibraryChange('pack_clips_changed', {
          packId: PACK_ID,
          packIds: [PACK_ID],
        }),
        NO_READS,
        null,
      ),
    ).toBeNull();
  });

  it('answers null for an unrelated change', () => {
    const state = stageState();
    expect(
      libraryChangeStateAtNow(
        state,
        buildVjLibraryChange('clip_deleted', { clipId: SCENE_ID }),
        NO_READS,
        null,
      ),
    ).toBeNull();
    expect(
      libraryChangeStateAtNow(
        state,
        buildVjLibraryChange('setlist_deleted', {
          setlistId: OTHER_PACK_ID,
          setlistIds: [OTHER_PACK_ID],
        }),
        NO_READS,
        null,
      ),
    ).toBeNull();
    expect(
      libraryChangeStateAtNow(
        state,
        buildVjLibraryChange('scene_updated', { sceneId: SCENE_ID }),
        NO_READS,
        null,
      ),
    ).toBeNull();
  });
});

/** A stage with the set list active on `index`, its step `itemId`, playing
 *  with a running clock unless the overrides say otherwise. */
function sequenceState(
  index: number | null,
  itemId: string | null,
  playback: Partial<VjSetlistPlayback> = {},
): VjStageState {
  return {
    ...stageState({ activeSetlistId: SETLIST_ID, setlistIndex: index }),
    setlistPlayback: {
      ...createVjSetlistPlayback(false),
      status: 'playing',
      itemId,
      isFlashConfirmed: true,
      stepStartedAt: NOW - 2000,
      stepEndsAt: NOW + 6000,
      stepDurationMs: 8000,
      ...playback,
    },
  };
}

function itemsChanged(setlistId: string = SETLIST_ID): VjLibraryChange {
  return buildVjLibraryChange('setlist_items_changed', {
    setlistId,
    setlistIds: [setlistId],
  });
}

function followReads(
  itemIds: string[] | null,
  isLooping = false,
  setlistId: string = SETLIST_ID,
): ReadonlyMap<string, VjSetlistFollowRead | null> {
  return new Map([
    [setlistId, itemIds === null ? null : { itemIds, isLooping }],
  ]);
}

/** The state after an item edit, or the input itself when nothing moved. */
function followed(
  state: VjStageState,
  nextItemIds: string[] | null,
  previousItemIds: readonly string[] | null,
  change: VjLibraryChange = itemsChanged(),
): VjStageState {
  return (
    libraryChangeStateAtNow(
      state,
      change,
      followReads(nextItemIds),
      previousItemIds,
    ) ?? state
  );
}

/** The index and item id a followed state ends on. */
function positionOf(state: VjStageState): {
  index: number | null;
  itemId: string | null;
} {
  return {
    index: state.setlistIndex,
    itemId: state.setlistPlayback.itemId,
  };
}

describe('vjLibraryChangeState index follow (sequences 7)', () => {
  describe('worked cases on [A, B, C, D]', () => {
    it('follows C moved first', () => {
      expect(
        positionOf(
          followed(
            sequenceState(2, ITEM_C),
            [ITEM_C, ITEM_A, ITEM_B, ITEM_D],
            OLD_ITEM_IDS,
          ),
        ),
      ).toEqual({ index: 0, itemId: ITEM_C });
    });

    it('shifts the index down when an item before it is removed', () => {
      const state = sequenceState(2, ITEM_C);
      const next = followed(state, [ITEM_B, ITEM_C, ITEM_D], OLD_ITEM_IDS);
      expect(positionOf(next)).toEqual({ index: 1, itemId: ITEM_C });
      expect(next.setlistPlayback).toEqual(state.setlistPlayback);
    });

    it('moves to the step before a removed C and forgets the item id', () => {
      const state = sequenceState(2, ITEM_C);
      const next = followed(state, [ITEM_A, ITEM_B, ITEM_D], OLD_ITEM_IDS);
      expect(positionOf(next)).toEqual({ index: 1, itemId: null });
      expect(next.setlistPlayback).toEqual({
        ...state.setlistPlayback,
        itemId: null,
      });
    });

    it('moves to A when B and C are removed', () => {
      expect(
        positionOf(
          followed(sequenceState(2, ITEM_C), [ITEM_A, ITEM_D], OLD_ITEM_IDS),
        ),
      ).toEqual({ index: 0, itemId: null });
    });

    it('answers no index when the first step A is removed', () => {
      expect(
        positionOf(
          followed(
            sequenceState(0, ITEM_A),
            [ITEM_B, ITEM_C, ITEM_D],
            OLD_ITEM_IDS,
          ),
        ),
      ).toEqual({ index: null, itemId: null });
    });

    it('leaves the stage alone when X is inserted after C', () => {
      expect(
        libraryChangeStateAtNow(
          sequenceState(2, ITEM_C),
          itemsChanged(),
          followReads([ITEM_A, ITEM_B, ITEM_C, ITEM_X, ITEM_D]),
          OLD_ITEM_IDS,
        ),
      ).toBeNull();
    });

    it('keeps the anchor on A when X is inserted after it, B removed earlier', () => {
      expect(
        libraryChangeStateAtNow(
          sequenceState(0, null),
          itemsChanged(),
          followReads([ITEM_A, ITEM_X, ITEM_C, ITEM_D]),
          [ITEM_A, ITEM_C, ITEM_D],
        ),
      ).toBeNull();
    });

    it('stops the clock and goes to manual when every item is removed', () => {
      const state = sequenceState(2, ITEM_C);
      const next = followed(state, [], OLD_ITEM_IDS);
      expect(next.activeSetlistId).toBe(SETLIST_ID);
      expect(next.setlistIndex).toBeNull();
      expect(next.setlistPlayback).toEqual({
        ...state.setlistPlayback,
        status: 'manual',
        itemId: null,
        stepStartedAt: null,
        stepEndsAt: null,
        stepDurationMs: null,
        pausedRemainingMs: null,
      });
    });

    it('moves to B when the scene of C is deleted', () => {
      const change = buildVjLibraryChange('scene_deleted', {
        sceneId: SCENE_ID,
        setlistIds: [SETLIST_ID],
      });
      expect(
        positionOf(
          followed(
            sequenceState(2, ITEM_C),
            [ITEM_A, ITEM_B, ITEM_D],
            OLD_ITEM_IDS,
            change,
          ),
        ),
      ).toEqual({ index: 1, itemId: null });
    });
  });

  describe('rules', () => {
    it('rule 1: a set list gone in between clears it', () => {
      const state = sequenceState(2, ITEM_C);
      expect(followed(state, null, OLD_ITEM_IDS)).toEqual({
        ...state,
        activeSetlistId: null,
        setlistIndex: null,
        setlistPlayback: createVjSetlistPlayback(false),
      });
    });

    it('rule 3: an item id still listed gives its new index without the old list', () => {
      expect(
        positionOf(followed(sequenceState(2, ITEM_C), [ITEM_C, ITEM_D], null)),
      ).toEqual({ index: 0, itemId: ITEM_C });
    });

    it('rule 4: keeps the status and the running clock', () => {
      const paused = sequenceState(3, ITEM_D, {
        status: 'paused',
        stepStartedAt: null,
        stepEndsAt: null,
        pausedRemainingMs: 3000,
      });
      const next = followed(paused, [ITEM_A, ITEM_C], OLD_ITEM_IDS);
      expect(positionOf(next)).toEqual({ index: 1, itemId: null });
      expect(next.setlistPlayback).toEqual({
        ...paused.setlistPlayback,
        itemId: null,
      });
    });

    it('rule 5: an armed set list stays armed and only takes the Loop copy', () => {
      const armed = sequenceState(null, null, {
        status: 'manual',
        stepStartedAt: null,
        stepEndsAt: null,
        stepDurationMs: null,
      });
      expect(
        libraryChangeStateAtNow(
          armed,
          itemsChanged(),
          followReads([ITEM_A]),
          OLD_ITEM_IDS,
        ),
      ).toBeNull();
      expect(
        libraryChangeStateAtNow(
          armed,
          itemsChanged(),
          followReads([ITEM_A], true),
          OLD_ITEM_IDS,
        ),
      ).toEqual({
        ...armed,
        setlistPlayback: { ...armed.setlistPlayback, isLooping: true },
      });
    });

    it('rule 6: with no item id the index follows the old item at it', () => {
      expect(
        positionOf(
          followed(
            sequenceState(1, null),
            [ITEM_X, ITEM_A, ITEM_B, ITEM_C],
            [ITEM_A, ITEM_B, ITEM_C],
          ),
        ),
      ).toEqual({ index: 2, itemId: null });
    });

    it('rule 7: with no item id and the old item at the index removed, the index moves to the step before', () => {
      expect(
        positionOf(
          followed(
            sequenceState(1, null),
            [ITEM_A, ITEM_C],
            [ITEM_A, ITEM_B, ITEM_C],
          ),
        ),
      ).toEqual({ index: 0, itemId: null });
      expect(
        positionOf(
          followed(sequenceState(0, null), [ITEM_B], [ITEM_A, ITEM_B]),
        ),
      ).toEqual({ index: null, itemId: null });
    });

    it('rule 8: an item id gone with no old list to place it clamps one below', () => {
      expect(
        positionOf(
          followed(sequenceState(2, ITEM_C), [ITEM_A, ITEM_B, ITEM_D], null),
        ),
      ).toEqual({ index: 1, itemId: null });
      expect(
        positionOf(
          followed(sequenceState(2, ITEM_C), [ITEM_A], [ITEM_A, ITEM_B]),
        ),
      ).toEqual({ index: 0, itemId: null });
      expect(
        positionOf(followed(sequenceState(0, ITEM_A), [ITEM_B], null)),
      ).toEqual({ index: null, itemId: null });
    });

    it('rule 9: with no item id and no old item at the index, the index clamps to the last step', () => {
      expect(
        positionOf(followed(sequenceState(3, null), [ITEM_A, ITEM_B], null)),
      ).toEqual({ index: 1, itemId: null });
      expect(
        positionOf(
          followed(sequenceState(3, null), [ITEM_A, ITEM_B], [ITEM_A, ITEM_B]),
        ),
      ).toEqual({ index: 1, itemId: null });
      expect(
        libraryChangeStateAtNow(
          sequenceState(1, null),
          itemsChanged(),
          followReads([ITEM_A, ITEM_B, ITEM_C]),
          null,
        ),
      ).toBeNull();
    });
  });
});

describe('vjLibraryChangeState for the active set list', () => {
  it('clears the set list and its playback on setlist_deleted', () => {
    const state = sequenceState(2, ITEM_C);
    expect(
      libraryChangeStateAtNow(
        state,
        buildVjLibraryChange('setlist_deleted', {
          setlistId: SETLIST_ID.toUpperCase(),
          setlistIds: [],
        }),
        NO_READS,
        OLD_ITEM_IDS,
      ),
    ).toEqual({
      ...state,
      activeSetlistId: null,
      setlistIndex: null,
      setlistPlayback: createVjSetlistPlayback(false),
    });
    expect(
      libraryChangeStateAtNow(
        state,
        buildVjLibraryChange('setlist_deleted', {
          setlistId: OTHER_PACK_ID,
          setlistIds: [OTHER_PACK_ID],
        }),
        NO_READS,
        OLD_ITEM_IDS,
      ),
    ).toBeNull();
  });

  it('copies the saved Loop into the stage on setlist_updated', () => {
    const state = sequenceState(2, ITEM_C);
    const updated = buildVjLibraryChange('setlist_updated', {
      setlistId: SETLIST_ID,
      setlistIds: [SETLIST_ID],
    });
    expect(
      libraryChangeStateAtNow(
        state,
        updated,
        followReads(OLD_ITEM_IDS, true),
        OLD_ITEM_IDS,
      ),
    ).toEqual({
      ...state,
      setlistPlayback: { ...state.setlistPlayback, isLooping: true },
    });
    expect(
      libraryChangeStateAtNow(
        state,
        updated,
        followReads(OLD_ITEM_IDS, false),
        OLD_ITEM_IDS,
      ),
    ).toBeNull();
    expect(
      libraryChangeStateAtNow(state, updated, followReads(null), OLD_ITEM_IDS),
    ).toEqual({
      ...state,
      activeSetlistId: null,
      setlistIndex: null,
      setlistPlayback: createVjSetlistPlayback(false),
    });
  });

  it('removes the deleted clip from the stage and follows the set list that held it', () => {
    const state = sequenceState(2, ITEM_C);
    const next = libraryChangeStateAtNow(
      state,
      buildVjLibraryChange('clip_deleted', {
        clipId: CLIP_ID,
        packIds: [PACK_ID],
        setlistIds: [SETLIST_ID],
      }),
      followReads([ITEM_A, ITEM_B, ITEM_D]),
      OLD_ITEM_IDS,
    );
    expect(next).toEqual({
      ...state,
      liveClipId: null,
      liveSince: null,
      clipSequence: 4,
      mix: { clipId: null, amount: 0, blendMode: 'multiply' },
      screenOverrides: {
        [OTHER_SCREEN_ID]: state.screenOverrides[OTHER_SCREEN_ID],
      },
      recentClipIds: [OTHER_CLIP_ID],
      shuffle: { ...state.shuffle, excludedClipIds: [OTHER_CLIP_ID] },
      setlistIndex: 1,
      setlistPlayback: {
        ...state.setlistPlayback,
        itemId: null,
        stepStartedAt: NOW - 8000,
        stepEndsAt: NOW,
      },
    });
  });

  it('ends the clock of a playing step at now when the delete empties its frame and removes its item', () => {
    const state = sequenceState(2, ITEM_C);
    const deleted = buildVjLibraryChange('clip_deleted', {
      clipId: CLIP_ID,
      setlistIds: [SETLIST_ID],
    });
    const later = NOW + 1500;
    const next = vjLibraryChangeState(
      state,
      deleted,
      followReads([ITEM_A, ITEM_B, ITEM_D]),
      OLD_ITEM_IDS,
      later,
    );
    expect(next?.liveClipId).toBeNull();
    expect(next?.setlistIndex).toBe(1);
    expect(next?.setlistPlayback).toEqual({
      ...state.setlistPlayback,
      itemId: null,
      stepStartedAt: later - 8000,
      stepEndsAt: later,
      stepDurationMs: 8000,
    });
    const clock = next?.setlistPlayback;
    expect((clock?.stepEndsAt ?? 0) - (clock?.stepStartedAt ?? 0)).toBe(
      clock?.stepDurationMs,
    );
  });

  it('keeps the step clock when the delete keeps the step item, leaves the live clip, or the run is paused', () => {
    const state = sequenceState(2, ITEM_C);
    const deleted = buildVjLibraryChange('clip_deleted', {
      clipId: CLIP_ID,
      setlistIds: [SETLIST_ID],
    });
    const keptItem = vjLibraryChangeState(
      state,
      deleted,
      followReads([ITEM_A, ITEM_C, ITEM_D]),
      OLD_ITEM_IDS,
      NOW + 1500,
    );
    expect(keptItem?.setlistPlayback).toEqual(state.setlistPlayback);

    const keptLive = vjLibraryChangeState(
      { ...state, liveClipId: OTHER_CLIP_ID },
      deleted,
      followReads([ITEM_A, ITEM_B, ITEM_D]),
      OLD_ITEM_IDS,
      NOW + 1500,
    );
    expect(keptLive?.setlistPlayback).toEqual({
      ...state.setlistPlayback,
      itemId: null,
    });

    const paused = sequenceState(2, ITEM_C, {
      status: 'paused',
      stepStartedAt: null,
      stepEndsAt: null,
      pausedRemainingMs: 6000,
    });
    const keptPaused = vjLibraryChangeState(
      paused,
      deleted,
      followReads([ITEM_A, ITEM_B, ITEM_D]),
      OLD_ITEM_IDS,
      NOW + 1500,
    );
    expect(keptPaused?.setlistPlayback).toEqual({
      ...paused.setlistPlayback,
      itemId: null,
    });
  });

  it('follows a clip delete that only touched the set list', () => {
    const state = sequenceState(3, ITEM_D);
    const next = libraryChangeStateAtNow(
      state,
      buildVjLibraryChange('clip_deleted', {
        clipId: '12121212-1212-4212-8212-121212121212',
        setlistIds: [SETLIST_ID],
      }),
      followReads([ITEM_A, ITEM_D]),
      OLD_ITEM_IDS,
    );
    expect(next).toEqual({ ...state, setlistIndex: 1 });
    expect(
      libraryChangeStateAtNow(
        state,
        buildVjLibraryChange('clip_deleted', {
          clipId: '12121212-1212-4212-8212-121212121212',
          setlistIds: [OTHER_PACK_ID],
        }),
        followReads([ITEM_A, ITEM_D], false, OTHER_PACK_ID),
        OLD_ITEM_IDS,
      ),
    ).toBeNull();
  });

  it('matches the read and the change ids without case', () => {
    const state = sequenceState(2, ITEM_C);
    const next = libraryChangeStateAtNow(
      state,
      itemsChanged(SETLIST_ID.toUpperCase()),
      followReads([ITEM_B, ITEM_C, ITEM_D], false, SETLIST_ID.toUpperCase()),
      OLD_ITEM_IDS,
    );
    expect(positionOf(next ?? state)).toEqual({ index: 1, itemId: ITEM_C });
  });

  it('waits when no read was made for the active set list', () => {
    expect(
      libraryChangeStateAtNow(
        sequenceState(2, ITEM_C),
        itemsChanged(),
        NO_READS,
        OLD_ITEM_IDS,
      ),
    ).toBeNull();
  });

  it('leaves the stage alone for another set list', () => {
    expect(
      libraryChangeStateAtNow(
        sequenceState(2, ITEM_C),
        itemsChanged(OTHER_PACK_ID),
        new Map([
          [OTHER_PACK_ID, { itemIds: [], isLooping: true }],
          [SETLIST_ID, { itemIds: [], isLooping: true }],
        ]),
        OLD_ITEM_IDS,
      ),
    ).toBeNull();
    expect(
      libraryChangeStateAtNow(
        stageState({ activeSetlistId: null, setlistIndex: null }),
        itemsChanged(),
        followReads([]),
        null,
      ),
    ).toBeNull();
  });
});
