import {
  vjPackClipKey,
  vjSetlistItemKey,
  type VjCommandLookup,
  type VjLookupResults,
  type VjSetlistItemRead,
} from './stage/vj-rule-kit';
import type { VjStageReadsService } from './vj-stage-reads.service';
import type { VjSceneLook } from './vj.contract';

/**
 * Turns a command's lookups (contract 7.7) into the answers its apply step
 * reads. Each distinct lookup is read once and every read runs in parallel;
 * every `clip` lookup merges into one `existingClipIds` read and the
 * `clipsInPack` lookups of one pack into one `clipIdsInPack` read. A rejected
 * read rejects the whole resolve, and the gateway answers `vj_server_error`.
 * Logs nothing.
 */

/** The answers as the reads fill them in. */
interface VjLookupAnswers {
  packs: Map<string, { eventId: string | null } | null>;
  existingClipIds: Set<string>;
  clipIdsInPack: Set<string>;
  packClips: Map<string, { isFavorite: boolean } | null>;
  scenes: Map<string, VjSceneLook | null>;
  setlistItems: Map<string, VjSetlistItemRead | null>;
}

/** The lookups grouped so each distinct read appears once. */
interface VjGroupedLookups {
  packIds: Set<string>;
  clipIds: Set<string>;
  clipIdsByPack: Map<string, Set<string>>;
  packClips: Map<string, { packId: string; clipId: string }>;
  sceneIds: Set<string>;
  setlistItems: Map<string, { setlistId: string; index: number | null }>;
}

/** Groups the lookups by the read that answers them, ids lowercased. */
function groupVjLookups(lookups: readonly VjCommandLookup[]): VjGroupedLookups {
  const grouped: VjGroupedLookups = {
    packIds: new Set(),
    clipIds: new Set(),
    clipIdsByPack: new Map(),
    packClips: new Map(),
    sceneIds: new Set(),
    setlistItems: new Map(),
  };
  for (const lookup of lookups) {
    switch (lookup.kind) {
      case 'pack':
        grouped.packIds.add(lookup.packId.toLowerCase());
        break;
      case 'clip':
        grouped.clipIds.add(lookup.clipId.toLowerCase());
        break;
      case 'clipsInPack': {
        const packId = lookup.packId.toLowerCase();
        const packClipIds = grouped.clipIdsByPack.get(packId) ?? new Set();
        for (const clipId of lookup.clipIds) {
          packClipIds.add(clipId.toLowerCase());
        }
        grouped.clipIdsByPack.set(packId, packClipIds);
        break;
      }
      case 'packClip':
        grouped.packClips.set(vjPackClipKey(lookup.packId, lookup.clipId), {
          packId: lookup.packId.toLowerCase(),
          clipId: lookup.clipId.toLowerCase(),
        });
        break;
      case 'scene':
        grouped.sceneIds.add(lookup.sceneId.toLowerCase());
        break;
      case 'setlistItem':
        grouped.setlistItems.set(
          vjSetlistItemKey(lookup.setlistId, lookup.index),
          { setlistId: lookup.setlistId.toLowerCase(), index: lookup.index },
        );
        break;
    }
  }
  return grouped;
}

/** One promise per distinct read, each writing its answer when it lands. */
function startVjLookupReads(
  reads: VjStageReadsService,
  grouped: VjGroupedLookups,
  answers: VjLookupAnswers,
): Promise<void>[] {
  const pending: Promise<void>[] = [];
  for (const packId of grouped.packIds) {
    pending.push(
      reads.readPackForStage(packId).then((pack) => {
        answers.packs.set(packId, pack);
      }),
    );
  }
  if (grouped.clipIds.size > 0) {
    pending.push(
      reads.existingClipIds([...grouped.clipIds]).then((existingIds) => {
        existingIds.forEach((clipId) => answers.existingClipIds.add(clipId));
      }),
    );
  }
  for (const [packId, clipIds] of grouped.clipIdsByPack) {
    pending.push(
      reads.clipIdsInPack(packId, [...clipIds]).then((heldIds) => {
        heldIds.forEach((clipId) => answers.clipIdsInPack.add(clipId));
      }),
    );
  }
  for (const [key, pair] of grouped.packClips) {
    pending.push(
      reads
        .readPackClipForAdvance(pair.packId, pair.clipId)
        .then((packClip) => {
          answers.packClips.set(key, packClip);
        }),
    );
  }
  for (const sceneId of grouped.sceneIds) {
    pending.push(
      reads.readSceneLook(sceneId).then((look) => {
        answers.scenes.set(sceneId, look);
      }),
    );
  }
  for (const [key, request] of grouped.setlistItems) {
    pending.push(
      reads.readSetlistItem(request.setlistId, request.index).then((answer) => {
        answers.setlistItems.set(
          key,
          answer === null ? null : { ...request, ...answer },
        );
      }),
    );
  }
  return pending;
}

/** Reads every distinct lookup once, in parallel, and answers the results the
 *  apply step's rules read (keys as `VjLookupResults` documents them). */
export async function resolveVjLookups(
  reads: VjStageReadsService,
  lookups: readonly VjCommandLookup[],
): Promise<VjLookupResults> {
  const answers: VjLookupAnswers = {
    packs: new Map(),
    existingClipIds: new Set(),
    clipIdsInPack: new Set(),
    packClips: new Map(),
    scenes: new Map(),
    setlistItems: new Map(),
  };
  await Promise.all(
    startVjLookupReads(reads, groupVjLookups(lookups), answers),
  );
  return answers;
}
