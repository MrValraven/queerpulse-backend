import { buildVjLibraryChange } from '../vj-library-kit';
import { createVjStageState, type VjStageState } from '../vj.contract';
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

const NO_COUNTS: ReadonlyMap<string, number | null> = new Map();

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
    const next = vjLibraryChangeState(
      state,
      buildVjLibraryChange('pack_deleted', { packId: PACK_ID.toUpperCase() }),
      NO_COUNTS,
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
      vjLibraryChangeState(
        state,
        buildVjLibraryChange('pack_deleted', { packId: OTHER_PACK_ID }),
        NO_COUNTS,
      ),
    ).toBeNull();
  });

  it('clears the live clip, the mix, overrides, history and exclusions on clip_deleted', () => {
    const state = stageState();
    const next = vjLibraryChangeState(
      state,
      buildVjLibraryChange('clip_deleted', {
        clipId: CLIP_ID,
        packIds: [PACK_ID],
      }),
      NO_COUNTS,
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
    const next = vjLibraryChangeState(
      state,
      buildVjLibraryChange('clip_deleted', { clipId: CLIP_ID }),
      NO_COUNTS,
    );
    expect(next).toEqual({ ...state, recentClipIds: [OTHER_CLIP_ID] });
    expect(next?.clipSequence).toBe(3);
    expect(next?.liveSince).toBe(NOW - 10_000);
  });

  it('hides the event card when the active pack unlinks its event', () => {
    const state = stageState();
    const next = vjLibraryChangeState(
      state,
      buildVjLibraryChange('pack_event_changed', {
        packId: PACK_ID,
        eventId: null,
      }),
      NO_COUNTS,
    );
    expect(next).toEqual({
      ...state,
      eventCard: { isVisible: false, kind: 'qr' },
    });
    expect(
      vjLibraryChangeState(
        state,
        buildVjLibraryChange('pack_event_changed', {
          packId: PACK_ID,
          eventId: EVENT_ID,
        }),
        NO_COUNTS,
      ),
    ).toBeNull();
    expect(
      vjLibraryChangeState(
        state,
        buildVjLibraryChange('pack_event_changed', {
          packId: OTHER_PACK_ID,
          eventId: null,
        }),
        NO_COUNTS,
      ),
    ).toBeNull();
  });

  it('clears the active set list on setlist_deleted', () => {
    const state = stageState();
    const next = vjLibraryChangeState(
      state,
      buildVjLibraryChange('setlist_deleted', {
        setlistId: SETLIST_ID,
        setlistIds: [SETLIST_ID],
      }),
      NO_COUNTS,
    );
    expect(next).toEqual({
      ...state,
      activeSetlistId: null,
      setlistIndex: null,
    });
  });

  it('nulls the set list index at or past the count after setlist_items_changed or scene_deleted', () => {
    const state = stageState();
    const shrunk = vjLibraryChangeState(
      state,
      buildVjLibraryChange('setlist_items_changed', {
        setlistId: SETLIST_ID,
        setlistIds: [SETLIST_ID],
      }),
      new Map([[SETLIST_ID, 3]]),
    );
    expect(shrunk).toEqual({ ...state, setlistIndex: null });
    const sceneDeleted = vjLibraryChangeState(
      state,
      buildVjLibraryChange('scene_deleted', {
        sceneId: SCENE_ID,
        setlistIds: [SETLIST_ID],
      }),
      new Map([[SETLIST_ID, 2]]),
    );
    expect(sceneDeleted).toEqual({ ...state, setlistIndex: null });
    const stillInside = vjLibraryChangeState(
      state,
      buildVjLibraryChange('setlist_items_changed', {
        setlistId: SETLIST_ID,
        setlistIds: [SETLIST_ID],
      }),
      new Map([[SETLIST_ID, 4]]),
    );
    expect(stillInside).toBeNull();
  });

  it('clears the active set list when its count read finds it gone and waits when no count was read', () => {
    const state = stageState();
    const change = buildVjLibraryChange('scene_deleted', {
      sceneId: SCENE_ID,
      setlistIds: [SETLIST_ID],
    });
    expect(
      vjLibraryChangeState(state, change, new Map([[SETLIST_ID, null]])),
    ).toEqual({ ...state, activeSetlistId: null, setlistIndex: null });
    expect(vjLibraryChangeState(state, change, NO_COUNTS)).toBeNull();
  });

  it('leaves stale excluded ids after pack_clips_changed', () => {
    const state = stageState();
    expect(
      vjLibraryChangeState(
        state,
        buildVjLibraryChange('pack_clips_changed', {
          packId: PACK_ID,
          packIds: [PACK_ID],
        }),
        NO_COUNTS,
      ),
    ).toBeNull();
  });

  it('answers null for an unrelated change', () => {
    const state = stageState();
    expect(
      vjLibraryChangeState(
        state,
        buildVjLibraryChange('clip_deleted', { clipId: SCENE_ID }),
        NO_COUNTS,
      ),
    ).toBeNull();
    expect(
      vjLibraryChangeState(
        state,
        buildVjLibraryChange('setlist_deleted', {
          setlistId: OTHER_PACK_ID,
          setlistIds: [OTHER_PACK_ID],
        }),
        NO_COUNTS,
      ),
    ).toBeNull();
    expect(
      vjLibraryChangeState(
        state,
        buildVjLibraryChange('scene_updated', { sceneId: SCENE_ID }),
        NO_COUNTS,
      ),
    ).toBeNull();
  });
});
