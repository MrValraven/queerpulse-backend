/**
 * Library changes on a live stage (contract 7.10 "Stage effects"): what a
 * deleted pack, clip or set list, an unlinked pack event, or a shrunk set list
 * leaves a stage in. Pure; the stage service lands the result with cause
 * `library`. Override entries of pruned screens are the stage service's
 * (plan note 22), and excluded ids that left the pack stay on purpose.
 */
import type {
  VjLibraryChange,
  VjScreenOverride,
  VjStageState,
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

/** The state with no active set list. */
function withoutActiveSetlist(state: VjStageState): VjStageState {
  return { ...state, activeSetlistId: null, setlistIndex: null };
}

/** The item count the gateway read for a set list, matched without case;
 *  undefined when it read none. */
function itemCountOf(
  setlistItemCounts: ReadonlyMap<string, number | null>,
  setlistId: string,
): number | null | undefined {
  if (setlistItemCounts.has(setlistId)) {
    return setlistItemCounts.get(setlistId);
  }
  for (const [countedSetlistId, itemCount] of setlistItemCounts) {
    if (countedSetlistId.toLowerCase() === setlistId) {
      return itemCount;
    }
  }
  return undefined;
}

/** `setlist_items_changed` or `scene_deleted` naming the active set list: an
 *  index at or past the read count becomes null. A null count (the set list
 *  went in between) clears the set list as its delete would; no count read
 *  leaves the stage alone. */
function setlistShrunkState(
  state: VjStageState,
  change: VjLibraryChange,
  setlistItemCounts: ReadonlyMap<string, number | null>,
): VjStageState | null {
  if (
    state.activeSetlistId === null ||
    !namesActiveSetlist(state, change.setlistIds)
  ) {
    return null;
  }
  const itemCount = itemCountOf(setlistItemCounts, state.activeSetlistId);
  if (itemCount === undefined) {
    return null;
  }
  if (itemCount === null) {
    return withoutActiveSetlist(state);
  }
  if (state.setlistIndex === null || state.setlistIndex < itemCount) {
    return null;
  }
  return { ...state, setlistIndex: null };
}

/** Contract 7.10 stage effects; null when the change does not touch the state. */
export function vjLibraryChangeState(
  state: VjStageState,
  change: VjLibraryChange,
  setlistItemCounts: ReadonlyMap<string, number | null>,
): VjStageState | null {
  switch (change.kind) {
    case 'pack_deleted':
      return packDeletedState(state, change);
    case 'clip_deleted':
      return clipDeletedState(state, change);
    case 'pack_event_changed':
      return packEventChangedState(state, change);
    case 'setlist_deleted':
      return namesActiveSetlist(state, [change.setlistId, ...change.setlistIds])
        ? withoutActiveSetlist(state)
        : null;
    case 'setlist_items_changed':
    case 'scene_deleted':
      return setlistShrunkState(state, change, setlistItemCounts);
    default:
      return null;
  }
}
