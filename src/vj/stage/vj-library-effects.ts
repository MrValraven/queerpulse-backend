/**
 * Library changes on a live stage (contract 7.10 "Stage effects", sequences
 * 5.9): what a deleted pack, clip or set list, an unlinked pack event, or an
 * edited active set list leaves a stage in. Pure; the stage service lands the
 * result with cause `library`. Override entries of pruned screens are the
 * stage service's (plan note 22), and excluded ids that left the pack stay on
 * purpose. The active set list follows its items through
 * `vjSetlistFollowState` (sequences 7): the index is found again from the
 * playback's item id, or from the item ids the stage held before the change.
 * A clip delete that empties the frame of a playing step ends its clock now.
 */
import {
  vjSetlistClearedState,
  vjSetlistFollowState,
  type VjLibraryChange,
  type VjScreenOverride,
  type VjSetlistFollowRead,
  type VjSetlistPlayback,
  type VjStageState,
} from '../vj.contract';

/** An id lowercased, or null. */
function lowercaseOrNull(id: string | null): string | null {
  return id === null ? null : id.toLowerCase();
}

/** `pack_deleted` of the active pack: v1 (no active pack, shuffle off,
 *  clipSequence + 1, the live clip kept), plus no exclusions and the event
 *  card hidden. */
function packDeletedState(
  state: VjStageState,
  change: VjLibraryChange,
): VjStageState | null {
  if (
    state.activePackId === null ||
    lowercaseOrNull(change.packId) !== state.activePackId
  ) {
    return null;
  }
  return {
    ...state,
    activePackId: null,
    shuffle: { ...state.shuffle, isOn: false, excludedClipIds: [] },
    eventCard: { ...state.eventCard, isVisible: false },
    clipSequence: state.clipSequence + 1,
  };
}

/** The overrides without any entry naming the clip; null when none does. */
function overridesWithoutClip(
  screenOverrides: Record<string, VjScreenOverride>,
  clipId: string,
): Record<string, VjScreenOverride> | null {
  const entries = Object.entries(screenOverrides);
  const keptEntries = entries.filter(
    ([, override]) => override.clipId?.toLowerCase() !== clipId,
  );
  return keptEntries.length === entries.length
    ? null
    : Object.fromEntries(keptEntries);
}

/** `clip_deleted`: the live clip goes (liveSince null, clipSequence + 1), the
 *  mix clears to amount 0 with its blend mode kept, override entries naming
 *  it go, and the id leaves the history and the exclusions. */
function clipDeletedState(
  state: VjStageState,
  change: VjLibraryChange,
): VjStageState | null {
  const clipId = lowercaseOrNull(change.clipId);
  if (clipId === null) {
    return null;
  }
  let next = state;
  let isChanged = false;
  if (state.liveClipId === clipId) {
    next = {
      ...next,
      liveClipId: null,
      liveSince: next.liveGeneratorId === null ? null : next.liveSince,
      clipSequence: next.clipSequence + 1,
    };
    isChanged = true;
  }
  if (state.mix.clipId === clipId) {
    next = {
      ...next,
      mix: { clipId: null, amount: 0, blendMode: state.mix.blendMode },
    };
    isChanged = true;
  }
  const screenOverrides = overridesWithoutClip(state.screenOverrides, clipId);
  if (screenOverrides !== null) {
    next = { ...next, screenOverrides };
    isChanged = true;
  }
  if (state.recentClipIds.includes(clipId)) {
    next = {
      ...next,
      recentClipIds: state.recentClipIds.filter(
        (recentClipId) => recentClipId !== clipId,
      ),
    };
    isChanged = true;
  }
  if (state.shuffle.excludedClipIds.includes(clipId)) {
    next = {
      ...next,
      shuffle: {
        ...next.shuffle,
        excludedClipIds: state.shuffle.excludedClipIds.filter(
          (excludedClipId) => excludedClipId !== clipId,
        ),
      },
    };
    isChanged = true;
  }
  return isChanged ? next : null;
}

/** `pack_event_changed` of the active pack to no event hides a shown card. */
function packEventChangedState(
  state: VjStageState,
  change: VjLibraryChange,
): VjStageState | null {
  if (
    change.eventId !== null ||
    !state.eventCard.isVisible ||
    state.activePackId === null ||
    lowercaseOrNull(change.packId) !== state.activePackId
  ) {
    return null;
  }
  return { ...state, eventCard: { ...state.eventCard, isVisible: false } };
}

/** Whether the change names the stage's active set list. */
function namesActiveSetlist(
  state: VjStageState,
  setlistIds: readonly (string | null)[],
): boolean {
  return (
    state.activeSetlistId !== null &&
    setlistIds.some(
      (setlistId) => lowercaseOrNull(setlistId) === state.activeSetlistId,
    )
  );
}

/** The follow read the gateway made for a set list, matched without case;
 *  undefined when it read none. */
function followReadOf(
  setlistReads: ReadonlyMap<string, VjSetlistFollowRead | null>,
  setlistId: string,
): VjSetlistFollowRead | null | undefined {
  if (setlistReads.has(setlistId)) {
    return setlistReads.get(setlistId);
  }
  for (const [readSetlistId, read] of setlistReads) {
    if (readSetlistId.toLowerCase() === setlistId) {
      return read;
    }
  }
  return undefined;
}

/** `setlist_items_changed`, `scene_deleted`, `setlist_updated` and a
 *  `clip_deleted` naming the active set list: the index and item id follow
 *  the items, and the Loop copy follows the saved Loop (sequences 7). A null
 *  read (the set list went in between) clears the set list as its delete
 *  would; no read leaves the stage alone. */
function setlistFollowedState(
  state: VjStageState,
  change: VjLibraryChange,
  setlistReads: ReadonlyMap<string, VjSetlistFollowRead | null>,
  previousItemIds: readonly string[] | null,
): VjStageState {
  const activeSetlistId = state.activeSetlistId;
  if (
    activeSetlistId === null ||
    !namesActiveSetlist(state, [change.setlistId, ...change.setlistIds])
  ) {
    return state;
  }
  const read = followReadOf(setlistReads, activeSetlistId);
  if (read === undefined) {
    return state;
  }
  return vjSetlistFollowState(state, {
    setlistId: activeSetlistId,
    previousItemIds,
    read,
  });
}

/** The running clock of a step cut to end at `now`, its length kept so
 *  `stepEndsAt - stepStartedAt === stepDurationMs` still holds (contract
 *  3.2); a clock that already ends by then is kept. */
function clockEndingAt(
  playback: VjSetlistPlayback,
  now: number,
): VjSetlistPlayback {
  if (
    playback.stepEndsAt === null ||
    playback.stepDurationMs === null ||
    playback.stepEndsAt <= now
  ) {
    return playback;
  }
  return {
    ...playback,
    stepStartedAt: now - playback.stepDurationMs,
    stepEndsAt: now,
  };
}

/** `clip_deleted`: the clip effects, then the follow. When the delete took
 *  the live clip and removed the item of the step a playing run shows, the
 *  screens would hold an empty frame until the step end, so the step clock
 *  ends at `now` and the step timer plays what follows at once. */
function clipDeletedFollowedState(
  state: VjStageState,
  change: VjLibraryChange,
  setlistReads: ReadonlyMap<string, VjSetlistFollowRead | null>,
  previousItemIds: readonly string[] | null,
  now: number,
): VjStageState {
  const cleared = clipDeletedState(state, change) ?? state;
  const next = setlistFollowedState(
    cleared,
    change,
    setlistReads,
    previousItemIds,
  );
  const isFrameEmptied =
    state.liveClipId !== null && cleared.liveClipId === null;
  const isPlayingStepRemoved =
    state.setlistPlayback.status === 'playing' &&
    next.setlistPlayback.status === 'playing' &&
    state.setlistPlayback.itemId !== null &&
    next.setlistPlayback.itemId === null;
  if (!isFrameEmptied || !isPlayingStepRemoved) {
    return next;
  }
  const playback = clockEndingAt(next.setlistPlayback, now);
  return playback === next.setlistPlayback
    ? next
    : { ...next, setlistPlayback: playback };
}

/** Contract 7.10 and sequences 5.9 stage effects, before the null answer. */
function libraryChangedState(
  state: VjStageState,
  change: VjLibraryChange,
  setlistReads: ReadonlyMap<string, VjSetlistFollowRead | null>,
  previousItemIds: readonly string[] | null,
  now: number,
): VjStageState {
  switch (change.kind) {
    case 'pack_deleted':
      return packDeletedState(state, change) ?? state;
    case 'clip_deleted':
      return clipDeletedFollowedState(
        state,
        change,
        setlistReads,
        previousItemIds,
        now,
      );
    case 'pack_event_changed':
      return packEventChangedState(state, change) ?? state;
    case 'setlist_deleted':
      return namesActiveSetlist(state, [change.setlistId, ...change.setlistIds])
        ? vjSetlistClearedState(state)
        : state;
    case 'setlist_items_changed':
    case 'scene_deleted':
    case 'setlist_updated':
      return setlistFollowedState(state, change, setlistReads, previousItemIds);
    default:
      return state;
  }
}

/** Contract 7.10 and sequences 5.9 stage effects; null when the change does
 *  not touch the state. `setlistReads` holds the gateway's follow reads by
 *  set list id; `previousItemIds` is the active set list's item ids as the
 *  stage held them before the change (null when unknown); `now` is the
 *  server epoch ms a cut step clock ends at (a `clip_deleted` that empties
 *  the frame of the playing step). */
export function vjLibraryChangeState(
  state: VjStageState,
  change: VjLibraryChange,
  setlistReads: ReadonlyMap<string, VjSetlistFollowRead | null>,
  previousItemIds: readonly string[] | null,
  now: number,
): VjStageState | null {
  const next = libraryChangedState(
    state,
    change,
    setlistReads,
    previousItemIds,
    now,
  );
  return next === state ? null : next;
}
