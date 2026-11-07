import { DataSource } from 'typeorm';
import { normalizeStoredVjSceneLook } from './vj-scene-look';
import {
  VJ_STAGE_CLIPS_IN_PACK_SQL,
  VJ_STAGE_EXISTING_CLIPS_SQL,
  VJ_STAGE_PACK_CLIP_SQL,
  VJ_STAGE_PACK_SQL,
  VJ_STAGE_SCENE_LOOK_SQL,
  VJ_STAGE_SETLIST_COUNT_SQL,
  VJ_STAGE_SETLIST_ITEM_SQL,
  VjStageReadsService,
} from './vj-stage-reads.service';

/** A v4 uuid in a numbered family: 1 packs, 2 clips, 3 scenes, 4 set lists,
 *  5 events. */
function uuidAt(family: number, position: number): string {
  return `a7190000-0000-4000-8000-${String(family)}${String(position).padStart(11, '0')}`;
}

const PACK_ID = uuidAt(1, 1);
const CLIP_ID = uuidAt(2, 1);
const OTHER_CLIP_ID = uuidAt(2, 2);
const SCENE_ID = uuidAt(3, 1);
const SETLIST_ID = uuidAt(4, 1);
const EVENT_ID = uuidAt(5, 1);
const MALFORMED_ID = 'not-a-uuid';

/** A stored look holding one catalog effect and one id the catalog lacks. */
function storedLookWithUnknownEffect(): Record<string, unknown> {
  return {
    source: { kind: 'clip', clipId: CLIP_ID },
    effects: {
      speed: 1,
      settings: {
        sparkle: { isOn: true, amount: 0.5, variant: null },
        glitch: { isOn: true, amount: 0.4, variant: null },
      },
    },
  };
}

describe('VjStageReadsService', () => {
  let query: jest.Mock;
  let reads: VjStageReadsService;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
    reads = new VjStageReadsService({ query } as unknown as DataSource);
  });

  it('reads a pack event link by lowercased id and null for an unknown pack', async () => {
    query.mockResolvedValueOnce([{ event_id: EVENT_ID }]);
    await expect(
      reads.readPackForStage(PACK_ID.toUpperCase()),
    ).resolves.toEqual({ eventId: EVENT_ID });
    expect(query).toHaveBeenCalledWith(VJ_STAGE_PACK_SQL, [PACK_ID]);

    query.mockResolvedValueOnce([{ event_id: null }]);
    await expect(reads.readPackForStage(PACK_ID)).resolves.toEqual({
      eventId: null,
    });

    query.mockResolvedValueOnce([]);
    await expect(reads.readPackForStage(PACK_ID)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(3);

    await expect(reads.readPackForStage(MALFORMED_ID)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('reads existing clip ids in one query, lowercased and once each', async () => {
    query.mockResolvedValueOnce([{ id: CLIP_ID }]);
    const existing = await reads.existingClipIds([
      CLIP_ID.toUpperCase(),
      CLIP_ID,
      OTHER_CLIP_ID,
      MALFORMED_ID,
    ]);
    expect(existing).toEqual(new Set([CLIP_ID]));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(VJ_STAGE_EXISTING_CLIPS_SQL, [
      [CLIP_ID, OTHER_CLIP_ID],
    ]);
  });

  it('answers an empty set with no query when no clip id is valid', async () => {
    await expect(reads.existingClipIds([MALFORMED_ID])).resolves.toEqual(
      new Set(),
    );
    await expect(reads.existingClipIds([])).resolves.toEqual(new Set());
    expect(query).not.toHaveBeenCalled();
  });

  it('reads the listed clips a pack holds in one query', async () => {
    query.mockResolvedValueOnce([{ clip_id: OTHER_CLIP_ID }]);
    const held = await reads.clipIdsInPack(PACK_ID.toUpperCase(), [
      CLIP_ID,
      OTHER_CLIP_ID.toUpperCase(),
    ]);
    expect(held).toEqual(new Set([OTHER_CLIP_ID]));
    expect(query).toHaveBeenCalledWith(VJ_STAGE_CLIPS_IN_PACK_SQL, [
      PACK_ID,
      [CLIP_ID, OTHER_CLIP_ID],
    ]);

    await expect(reads.clipIdsInPack(MALFORMED_ID, [CLIP_ID])).resolves.toEqual(
      new Set(),
    );
    await expect(reads.clipIdsInPack(PACK_ID, [MALFORMED_ID])).resolves.toEqual(
      new Set(),
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reads a pack clip favorite flag and null when the pack lacks the clip', async () => {
    query.mockResolvedValueOnce([{ is_favorite: true }]);
    await expect(
      reads.readPackClipForAdvance(
        PACK_ID.toUpperCase(),
        CLIP_ID.toUpperCase(),
      ),
    ).resolves.toEqual({ isFavorite: true });
    expect(query).toHaveBeenCalledWith(VJ_STAGE_PACK_CLIP_SQL, [
      PACK_ID,
      CLIP_ID,
    ]);

    query.mockResolvedValueOnce([]);
    await expect(
      reads.readPackClipForAdvance(PACK_ID, CLIP_ID),
    ).resolves.toBeNull();

    await expect(
      reads.readPackClipForAdvance(PACK_ID, MALFORMED_ID),
    ).resolves.toBeNull();
    await expect(
      reads.readPackClipForAdvance(MALFORMED_ID, CLIP_ID),
    ).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('reads a scene look through the normaliser and drops an unknown effect id', async () => {
    query.mockResolvedValueOnce([{ look: storedLookWithUnknownEffect() }]);
    const look = await reads.readSceneLook(SCENE_ID.toUpperCase());
    expect(query).toHaveBeenCalledWith(VJ_STAGE_SCENE_LOOK_SQL, [SCENE_ID]);
    expect(look).toEqual(
      normalizeStoredVjSceneLook(storedLookWithUnknownEffect()),
    );
    expect(look?.effects.settings).toEqual({
      glitch: { isOn: true, amount: 0.4, variant: null },
    });

    query.mockResolvedValueOnce([]);
    await expect(reads.readSceneLook(SCENE_ID)).resolves.toBeNull();

    await expect(reads.readSceneLook(MALFORMED_ID)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('reads the set list item at an offset with its scene look', async () => {
    query.mockResolvedValueOnce([
      {
        item_count: 4,
        scene_id: SCENE_ID.toUpperCase(),
        look: storedLookWithUnknownEffect(),
      },
    ]);
    await expect(
      reads.readSetlistItem(SETLIST_ID.toUpperCase(), 2),
    ).resolves.toEqual({
      itemCount: 4,
      sceneId: SCENE_ID,
      look: normalizeStoredVjSceneLook(storedLookWithUnknownEffect()),
    });
    expect(query).toHaveBeenCalledWith(VJ_STAGE_SETLIST_ITEM_SQL, [
      SETLIST_ID,
      2,
    ]);
    expect(VJ_STAGE_SETLIST_ITEM_SQL).toContain(
      'ORDER BY "indexed_item"."position", "indexed_item"."id" OFFSET $2::int LIMIT 1',
    );
  });

  it('answers the count with a null scene past the last item and for a null index', async () => {
    query.mockResolvedValueOnce([
      { item_count: '3', scene_id: null, look: null },
    ]);
    await expect(reads.readSetlistItem(SETLIST_ID, 3)).resolves.toEqual({
      itemCount: 3,
      sceneId: null,
      look: null,
    });

    query.mockResolvedValueOnce([{ item_count: 3 }]);
    await expect(reads.readSetlistItem(SETLIST_ID, null)).resolves.toEqual({
      itemCount: 3,
      sceneId: null,
      look: null,
    });
    expect(query).toHaveBeenLastCalledWith(VJ_STAGE_SETLIST_COUNT_SQL, [
      SETLIST_ID,
    ]);

    query.mockResolvedValueOnce([{ item_count: 3 }]);
    await expect(reads.readSetlistItem(SETLIST_ID, -1)).resolves.toEqual({
      itemCount: 3,
      sceneId: null,
      look: null,
    });
    expect(query).toHaveBeenLastCalledWith(VJ_STAGE_SETLIST_COUNT_SQL, [
      SETLIST_ID,
    ]);
  });

  it('reads the count only for an index a set list cannot hold, so the offset always fits an int', async () => {
    for (const index of [100, 3_000_000_000]) {
      query.mockResolvedValueOnce([{ item_count: 3 }]);
      await expect(reads.readSetlistItem(SETLIST_ID, index)).resolves.toEqual({
        itemCount: 3,
        sceneId: null,
        look: null,
      });
      expect(query).toHaveBeenLastCalledWith(VJ_STAGE_SETLIST_COUNT_SQL, [
        SETLIST_ID,
      ]);
    }

    query.mockResolvedValueOnce([
      { item_count: 3, scene_id: null, look: null },
    ]);
    await reads.readSetlistItem(SETLIST_ID, 99);
    expect(query).toHaveBeenLastCalledWith(VJ_STAGE_SETLIST_ITEM_SQL, [
      SETLIST_ID,
      99,
    ]);
  });

  it('answers null for a set list gone and skips the query for a malformed id', async () => {
    query.mockResolvedValueOnce([]);
    await expect(reads.readSetlistItem(SETLIST_ID, 0)).resolves.toBeNull();
    query.mockResolvedValueOnce([]);
    await expect(reads.readSetlistItem(SETLIST_ID, null)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(2);

    await expect(reads.readSetlistItem(MALFORMED_ID, 0)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('reads a set list item count and null for an unknown set list', async () => {
    query.mockResolvedValueOnce([{ item_count: '5' }]);
    await expect(
      reads.setlistItemCount(SETLIST_ID.toUpperCase()),
    ).resolves.toBe(5);
    expect(query).toHaveBeenCalledWith(VJ_STAGE_SETLIST_COUNT_SQL, [
      SETLIST_ID,
    ]);

    query.mockResolvedValueOnce([]);
    await expect(reads.setlistItemCount(SETLIST_ID)).resolves.toBeNull();

    await expect(reads.setlistItemCount(MALFORMED_ID)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
