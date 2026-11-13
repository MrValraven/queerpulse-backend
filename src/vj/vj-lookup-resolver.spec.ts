import { vjPackClipKey, vjSetlistItemKey } from './stage/vj-rule-kit';
import { resolveVjLookups } from './vj-lookup-resolver';
import { normalizeStoredVjSceneLook } from './vj-scene-look';
import type { VjStageReadsService } from './vj-stage-reads.service';
import {
  DEFAULT_VJ_STEP_DURATION,
  type VjSetlistRead,
  type VjSetlistReadPosition,
} from './vj.contract';

/** A v4 uuid in a numbered family: 1 packs, 2 clips, 3 scenes, 4 set lists,
 *  5 events, 6 set list items. */
function uuidAt(family: number, position: number): string {
  return `a7191000-0000-4000-8000-${String(family)}${String(position).padStart(11, '0')}`;
}

const PACK_ID = uuidAt(1, 1);
const OTHER_PACK_ID = uuidAt(1, 2);
const CLIP_ID = uuidAt(2, 1);
const OTHER_CLIP_ID = uuidAt(2, 2);
const THIRD_CLIP_ID = uuidAt(2, 3);
const SCENE_ID = uuidAt(3, 1);
const SETLIST_ID = uuidAt(4, 1);
const EVENT_ID = uuidAt(5, 1);
const ITEM_ID = uuidAt(6, 1);
const OTHER_ITEM_ID = uuidAt(6, 2);

const COUNT: VjSetlistReadPosition = { kind: 'count' };
const SECOND_STEP: VjSetlistReadPosition = {
  kind: 'index',
  index: 1,
  wrapsToFirst: false,
};
const SECOND_STEP_WRAPPING: VjSetlistReadPosition = {
  kind: 'index',
  index: 1,
  wrapsToFirst: true,
};
const LAST_STEP: VjSetlistReadPosition = { kind: 'last' };

type ReadsMock = {
  [Method in keyof VjStageReadsService]: jest.Mock;
};

/** Every read answering its empty answer at once. */
function mockReads(): ReadsMock {
  return {
    readPackForStage: jest.fn().mockResolvedValue(null),
    existingClipIds: jest.fn().mockResolvedValue(new Set()),
    clipIdsInPack: jest.fn().mockResolvedValue(new Set()),
    readPackClipForAdvance: jest.fn().mockResolvedValue(null),
    readSceneLook: jest.fn().mockResolvedValue(null),
    readSetlist: jest.fn().mockResolvedValue(null),
    readSetlistFollow: jest.fn().mockResolvedValue(null),
  };
}

function resolveWith(
  reads: ReadsMock,
  lookups: Parameters<typeof resolveVjLookups>[1],
) {
  return resolveVjLookups(reads as unknown as VjStageReadsService, lookups);
}

describe('resolveVjLookups', () => {
  it('reads each distinct lookup once and in parallel', async () => {
    const reads = mockReads();
    const releases: (() => void)[] = [];
    const held = <Answer>(answer: Answer) =>
      new Promise<Answer>((resolve) => {
        releases.push(() => resolve(answer));
      });
    reads.readPackForStage.mockImplementation(() =>
      held({ eventId: EVENT_ID }),
    );
    reads.readSceneLook.mockImplementation(() => held(null));

    const resolving = resolveWith(reads, [
      { kind: 'pack', packId: PACK_ID },
      { kind: 'pack', packId: PACK_ID.toUpperCase() },
      { kind: 'scene', sceneId: SCENE_ID },
      { kind: 'scene', sceneId: SCENE_ID },
    ]);
    await Promise.resolve();

    expect(reads.readPackForStage).toHaveBeenCalledTimes(1);
    expect(reads.readPackForStage).toHaveBeenCalledWith(PACK_ID);
    expect(reads.readSceneLook).toHaveBeenCalledTimes(1);
    expect(releases).toHaveLength(2);

    releases.forEach((release) => release());
    const results = await resolving;
    expect(results.packs).toEqual(new Map([[PACK_ID, { eventId: EVENT_ID }]]));
    expect(results.scenes).toEqual(new Map([[SCENE_ID, null]]));
    expect(reads.readSetlistFollow).not.toHaveBeenCalled();
  });

  it('merges clip lookups into one read', async () => {
    const reads = mockReads();
    reads.existingClipIds.mockResolvedValue(new Set([CLIP_ID]));
    reads.clipIdsInPack.mockResolvedValue(new Set([OTHER_CLIP_ID]));

    const results = await resolveWith(reads, [
      { kind: 'clip', clipId: CLIP_ID },
      { kind: 'clip', clipId: OTHER_CLIP_ID.toUpperCase() },
      { kind: 'clip', clipId: CLIP_ID },
      { kind: 'clipsInPack', packId: PACK_ID, clipIds: [OTHER_CLIP_ID] },
      { kind: 'clipsInPack', packId: PACK_ID, clipIds: [THIRD_CLIP_ID] },
    ]);

    expect(reads.existingClipIds).toHaveBeenCalledTimes(1);
    expect(reads.existingClipIds).toHaveBeenCalledWith([
      CLIP_ID,
      OTHER_CLIP_ID,
    ]);
    expect(reads.clipIdsInPack).toHaveBeenCalledTimes(1);
    expect(reads.clipIdsInPack).toHaveBeenCalledWith(PACK_ID, [
      OTHER_CLIP_ID,
      THIRD_CLIP_ID,
    ]);
    expect(results.existingClipIds).toEqual(new Set([CLIP_ID]));
    expect(results.clipIdsInPack).toEqual(new Set([OTHER_CLIP_ID]));
  });

  it('keys pack clip answers', async () => {
    const reads = mockReads();
    reads.readPackClipForAdvance.mockImplementation((packId: string) =>
      Promise.resolve(packId === PACK_ID ? { isFavorite: true } : null),
    );

    const results = await resolveWith(reads, [
      { kind: 'packClip', packId: PACK_ID.toUpperCase(), clipId: CLIP_ID },
      { kind: 'packClip', packId: OTHER_PACK_ID, clipId: CLIP_ID },
    ]);

    expect(reads.readPackClipForAdvance).toHaveBeenCalledWith(PACK_ID, CLIP_ID);
    expect(results.packClips.get(vjPackClipKey(PACK_ID, CLIP_ID))).toEqual({
      isFavorite: true,
    });
    expect(
      results.packClips.get(vjPackClipKey(OTHER_PACK_ID, CLIP_ID)),
    ).toBeNull();
  });

  it('reads each distinct set list position once and keys the read by it', async () => {
    const reads = mockReads();
    const look = normalizeStoredVjSceneLook(null);
    const stepRead: VjSetlistRead = {
      setlistId: SETLIST_ID,
      isLooping: true,
      stepDuration: DEFAULT_VJ_STEP_DURATION,
      itemIds: [OTHER_ITEM_ID, ITEM_ID],
      step: {
        kind: 'scene',
        itemId: ITEM_ID,
        index: 1,
        sceneId: SCENE_ID,
        look,
        duration: DEFAULT_VJ_STEP_DURATION,
      },
    };
    const countRead: VjSetlistRead = { ...stepRead, step: null };
    reads.readSetlist.mockImplementation(
      (_setlistId: string, position: VjSetlistReadPosition) =>
        Promise.resolve(position.kind === 'count' ? countRead : stepRead),
    );

    const results = await resolveWith(reads, [
      {
        kind: 'setlistItem',
        setlistId: SETLIST_ID.toUpperCase(),
        position: SECOND_STEP,
      },
      { kind: 'setlistItem', setlistId: SETLIST_ID, position: SECOND_STEP },
      {
        kind: 'setlistItem',
        setlistId: SETLIST_ID,
        position: SECOND_STEP_WRAPPING,
      },
      { kind: 'setlistItem', setlistId: SETLIST_ID, position: COUNT },
      { kind: 'setlistItem', setlistId: SETLIST_ID, position: LAST_STEP },
    ]);

    expect(reads.readSetlist).toHaveBeenCalledTimes(4);
    expect(reads.readSetlist).toHaveBeenCalledWith(SETLIST_ID, SECOND_STEP);
    expect(reads.readSetlist).toHaveBeenCalledWith(
      SETLIST_ID,
      SECOND_STEP_WRAPPING,
    );
    expect(reads.readSetlist).toHaveBeenCalledWith(SETLIST_ID, COUNT);
    expect(reads.readSetlist).toHaveBeenCalledWith(SETLIST_ID, LAST_STEP);
    expect(results.setlistItems.size).toBe(4);
    expect(
      results.setlistItems.get(vjSetlistItemKey(SETLIST_ID, SECOND_STEP)),
    ).toBe(stepRead);
    expect(
      results.setlistItems.get(
        vjSetlistItemKey(SETLIST_ID, SECOND_STEP_WRAPPING),
      ),
    ).toBe(stepRead);
    expect(results.setlistItems.get(vjSetlistItemKey(SETLIST_ID, COUNT))).toBe(
      countRead,
    );
    expect(
      results.setlistItems.get(vjSetlistItemKey(SETLIST_ID, LAST_STEP)),
    ).toBe(stepRead);
    expect(reads.readSetlistFollow).not.toHaveBeenCalled();
  });

  it('answers a set list gone with null and no lookups with empty answers', async () => {
    const reads = mockReads();
    const goneResults = await resolveWith(reads, [
      { kind: 'setlistItem', setlistId: SETLIST_ID, position: SECOND_STEP },
    ]);
    expect(
      goneResults.setlistItems.get(vjSetlistItemKey(SETLIST_ID, SECOND_STEP)),
    ).toBeNull();

    const emptyResults = await resolveWith(reads, []);
    expect(emptyResults.packs.size).toBe(0);
    expect(emptyResults.existingClipIds.size).toBe(0);
    expect(emptyResults.setlistItems.size).toBe(0);
    expect(reads.existingClipIds).not.toHaveBeenCalled();
  });

  it('rejects when a set list read fails, so the step timer can retry', async () => {
    const reads = mockReads();
    const failure = new Error('connection reset');
    reads.readSetlist.mockRejectedValue(failure);

    await expect(
      resolveWith(reads, [
        { kind: 'setlistItem', setlistId: SETLIST_ID, position: LAST_STEP },
      ]),
    ).rejects.toBe(failure);
  });

  it('rejects when a read fails', async () => {
    const reads = mockReads();
    const failure = new Error('connection reset');
    reads.readSceneLook.mockRejectedValue(failure);

    await expect(
      resolveWith(reads, [
        { kind: 'pack', packId: PACK_ID },
        { kind: 'scene', sceneId: SCENE_ID },
      ]),
    ).rejects.toBe(failure);
  });
});
