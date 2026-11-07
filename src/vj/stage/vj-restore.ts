/**
 * Restore v2 (contract 7.13): the reads a screen's saved state needs and the
 * stage it seeds. The payload goes through `upgradeVjStageFieldsV1` first, so
 * a v1-shaped snapshot seeds a v2 stage. Each part is read on its own by the
 * restore reader of the module that owns its command; a bad field takes its
 * default and an id the reads did not find is dropped.
 */
import {
  canonicalVjStageState,
  createVjStageState,
  upgradeVjStageFieldsV1,
  VJ_LIMITS,
  type VjGeneratorId,
  type VjStageState,
} from '../vj.contract';
import { checkVjGeneratorChoice } from '../vj-field-checks';
import { restoredVjEffects } from './vj-effects-rules';
import {
  restoredVjCountdown,
  restoredVjEventCard,
  restoredVjLogo,
  restoredVjOverlay,
  restoredVjTransition,
} from './vj-look-rules';
import {
  isRecord,
  isSafeIntegerInRange,
  isUuidString,
  vjSetlistItemKey,
  type VjCommandLookup,
  type VjLookupResults,
} from './vj-rule-kit';
import { restoredVjShuffle } from './vj-shuffle-rules';
import { restoredVjMix } from './vj-source-rules';
import { restoredVjTempo } from './vj-tempo-rules';

/** The ids a restore names, each uuid-shaped and lowercased (null otherwise). */
interface VjRestoreIds {
  packId: string | null;
  liveClipId: string | null;
  mixClipId: string | null;
  /** Lowercased, each once, sorted, at most VJ_LIMITS.excludedClipIdsMax. */
  excludedClipIds: string[];
  setlistId: string | null;
}

/** The live source a restore keeps: a found clip, else a valid generator, else black. */
interface VjRestoredSource {
  liveClipId: string | null;
  liveGeneratorId: VjGeneratorId | null;
  liveGeneratorVariant: string | null;
}

/** A uuid lowercased, or null for anything else. */
function uuidOrNull(value: unknown): string | null {
  return isUuidString(value) ? value.toLowerCase() : null;
}

/** The restore payload after the v1 upgrade; null when it is not an object. */
function upgradedRestoreOf(
  restoreState: unknown,
  now: number,
): Record<string, unknown> | null {
  return isRecord(restoreState)
    ? upgradeVjStageFieldsV1(restoreState, now)
    : null;
}

/** The ids the restore's reads need. */
function restoreIdsOf(restore: Record<string, unknown>): VjRestoreIds {
  const mix = isRecord(restore.mix) ? restore.mix : {};
  const shuffle = isRecord(restore.shuffle) ? restore.shuffle : {};
  const sentExcludedClipIds: unknown[] = Array.isArray(shuffle.excludedClipIds)
    ? (shuffle.excludedClipIds as unknown[])
    : [];
  const excludedClipIds = [
    ...new Set(
      sentExcludedClipIds
        .filter((clipId): clipId is string => isUuidString(clipId))
        .map((clipId) => clipId.toLowerCase()),
    ),
  ]
    .sort()
    .slice(0, VJ_LIMITS.excludedClipIdsMax);
  return {
    packId: uuidOrNull(restore.activePackId),
    liveClipId: uuidOrNull(restore.liveClipId),
    mixClipId: uuidOrNull(mix.clipId),
    excludedClipIds,
    setlistId: uuidOrNull(restore.activeSetlistId),
  };
}

/** The reads a restore needs (contract 7.13): pack, live clip, mix clip, excluded clips in the pack, the set list count. Runs upgradeVjStageFieldsV1 first. */
export function vjRestoreLookups(
  restoreState: unknown,
  now: number,
): VjCommandLookup[] {
  const restore = upgradedRestoreOf(restoreState, now);
  if (restore === null) {
    return [];
  }
  const ids = restoreIdsOf(restore);
  const lookups: VjCommandLookup[] = [];
  if (ids.packId !== null) {
    lookups.push({ kind: 'pack', packId: ids.packId });
  }
  if (ids.liveClipId !== null) {
    lookups.push({ kind: 'clip', clipId: ids.liveClipId });
  }
  if (ids.mixClipId !== null && ids.mixClipId !== ids.liveClipId) {
    lookups.push({ kind: 'clip', clipId: ids.mixClipId });
  }
  if (ids.packId !== null && ids.excludedClipIds.length > 0) {
    lookups.push({
      kind: 'clipsInPack',
      packId: ids.packId,
      clipIds: ids.excludedClipIds,
    });
  }
  if (ids.setlistId !== null) {
    lookups.push({
      kind: 'setlistItem',
      setlistId: ids.setlistId,
      index: null,
    });
  }
  return lookups;
}

/** The restored pack: kept when the read found it, with whether it links an event. */
function restoredPackOf(
  packId: string | null,
  reads: VjLookupResults,
): { packId: string | null; hasLinkedEvent: boolean } {
  if (packId === null) {
    return { packId: null, hasLinkedEvent: false };
  }
  const pack = reads.packs.get(packId) ?? null;
  if (pack === null) {
    return { packId: null, hasLinkedEvent: false };
  }
  return { packId, hasLinkedEvent: pack.eventId !== null };
}

/** A restored generator: an unknown id restores black; a bad variant takes the generator's default. */
function restoredGeneratorOf(
  restore: Record<string, unknown>,
): VjRestoredSource {
  const sentChoice = checkVjGeneratorChoice(
    restore.liveGeneratorId,
    restore.liveGeneratorVariant,
    { isVariantRequired: false },
  );
  const choice =
    sentChoice.failure === null
      ? sentChoice
      : checkVjGeneratorChoice(restore.liveGeneratorId, undefined, {
          isVariantRequired: false,
        });
  if (choice.failure !== null) {
    return {
      liveClipId: null,
      liveGeneratorId: null,
      liveGeneratorVariant: null,
    };
  }
  return {
    liveClipId: null,
    liveGeneratorId: choice.value.generatorId,
    liveGeneratorVariant: choice.value.generatorVariant,
  };
}

/** The restored live source: a clip the reads found wins; otherwise the generator. */
function restoredSourceOf(
  restore: Record<string, unknown>,
  liveClipId: string | null,
  existingClipIds: ReadonlySet<string>,
): VjRestoredSource {
  if (liveClipId !== null && existingClipIds.has(liveClipId)) {
    return { liveClipId, liveGeneratorId: null, liveGeneratorVariant: null };
  }
  return restoredGeneratorOf(restore);
}

/** The restored set list: kept when the read found it; an index that is no
 *  integer, or at or past the item count, becomes null. */
function restoredSetlistOf(
  restore: Record<string, unknown>,
  setlistId: string | null,
  reads: VjLookupResults,
): { activeSetlistId: string | null; setlistIndex: number | null } {
  if (setlistId === null) {
    return { activeSetlistId: null, setlistIndex: null };
  }
  const setlist = reads.setlistItems.get(vjSetlistItemKey(setlistId, null));
  if (setlist === undefined || setlist === null) {
    return { activeSetlistId: null, setlistIndex: null };
  }
  const sentIndex = restore.setlistIndex;
  return {
    activeSetlistId: setlistId,
    setlistIndex: isSafeIntegerInRange(sentIndex, 0, setlist.itemCount - 1)
      ? sentIndex
      : null,
  };
}

/** Contract 7.13 adoption: revision 1, clipSequence 1, overrides {}, history [liveClipId] or [], liveSince now when a source is live.
 *  A payload that is not an object restores nothing and answers `base` as it is. */
export function restoredVjStageState(
  base: VjStageState,
  restoreState: unknown,
  reads: VjLookupResults,
  now: number,
): VjStageState {
  const restore = upgradedRestoreOf(restoreState, now);
  if (restore === null) {
    return base;
  }
  const defaults = createVjStageState(base.stageEpoch, now);
  const ids = restoreIdsOf(restore);
  const existingClipIds = new Set(
    [...reads.existingClipIds].map((clipId) => clipId.toLowerCase()),
  );
  const pack = restoredPackOf(ids.packId, reads);
  const source = restoredSourceOf(restore, ids.liveClipId, existingClipIds);
  const setlist = restoredSetlistOf(restore, ids.setlistId, reads);
  const isSourceLive =
    source.liveClipId !== null || source.liveGeneratorId !== null;
  const clipIdsInPack: ReadonlySet<string> =
    pack.packId === null
      ? new Set<string>()
      : new Set([...reads.clipIdsInPack].map((clipId) => clipId.toLowerCase()));
  return canonicalVjStageState({
    ...defaults,
    revision: 1,
    clipSequence: 1,
    activePackId: pack.packId,
    ...source,
    liveSince: isSourceLive ? now : null,
    transition: restoredVjTransition(restore.transition, defaults.transition),
    overlay: restoredVjOverlay(restore.overlay, defaults.overlay, now),
    countdown: restoredVjCountdown(restore.countdown, defaults.countdown, now),
    logo: restoredVjLogo(restore.logo, defaults.logo),
    eventCard: restoredVjEventCard(
      restore.eventCard,
      defaults.eventCard,
      pack.hasLinkedEvent,
    ),
    effects: restoredVjEffects(restore.effects, defaults.effects),
    mix: restoredVjMix(restore.mix, defaults.mix, (clipId) =>
      existingClipIds.has(clipId),
    ),
    tempo: restoredVjTempo(restore.tempo, defaults.tempo),
    shuffle: restoredVjShuffle(
      restore.shuffle,
      defaults.shuffle,
      clipIdsInPack,
    ),
    recentClipIds: source.liveClipId === null ? [] : [source.liveClipId],
    screenOverrides: {},
    activeSetlistId: setlist.activeSetlistId,
    setlistIndex: setlist.setlistIndex,
    updatedAt: now,
  });
}
