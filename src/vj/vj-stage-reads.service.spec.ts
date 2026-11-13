import { DataSource } from 'typeorm';
import { normalizeStoredVjSceneLook } from './vj-scene-look';
import {
  VJ_STAGE_CLIPS_IN_PACK_SQL,
  VJ_STAGE_EXISTING_CLIPS_SQL,
  VJ_STAGE_PACK_CLIP_SQL,
  VJ_STAGE_PACK_SQL,
  VJ_STAGE_SCENE_LOOK_SQL,
  VJ_STAGE_SETLIST_FOLLOW_SQL,
  VJ_STAGE_SETLIST_READ_SQL,
  VjStageReadsService,
} from './vj-stage-reads.service';
import { DEFAULT_VJ_STEP_DURATION } from './vj.contract';

/** A v4 uuid in a numbered family: 1 packs, 2 clips, 3 scenes, 4 set lists,
 *  5 events, 6 set list items. */
function uuidAt(family: number, position: number): string {
  return `a7190000-0000-4000-8000-${String(family)}${String(position).padStart(11, '0')}`;
}

const PACK_ID = uuidAt(1, 1);
const CLIP_ID = uuidAt(2, 1);
const OTHER_CLIP_ID = uuidAt(2, 2);
const SCENE_ID = uuidAt(3, 1);
const SETLIST_ID = uuidAt(4, 1);
const ITEM_ID = uuidAt(6, 1);
const OTHER_ITEM_ID = uuidAt(6, 2);
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

  it('reads a set list in one query: Loop, default length, item ids and a scene step', async () => {
    query.mockResolvedValueOnce([
      setlistRow({
        item_id: ITEM_ID.toUpperCase(),
        item_index: 1,
        kind: 'scene',
        scene_id: SCENE_ID.toUpperCase(),
        look: storedLookWithUnknownEffect(),
      }),
    ]);
    await expect(
      reads.readSetlist(SETLIST_ID.toUpperCase(), {
        kind: 'index',
        index: 1,
        wrapsToFirst: false,
      }),
    ).resolves.toEqual({
      setlistId: SETLIST_ID,
      isLooping: true,
      stepDuration: { kind: 'beats', value: 16 },
      itemIds: [OTHER_ITEM_ID, ITEM_ID],
      step: {
        kind: 'scene',
        itemId: ITEM_ID,
        index: 1,
        sceneId: SCENE_ID,
        look: normalizeStoredVjSceneLook(storedLookWithUnknownEffect()),
        duration: { kind: 'beats', value: 16 },
      },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(VJ_STAGE_SETLIST_READ_SQL, [
      SETLIST_ID,
      1,
      'none',
    ]);
  });

  it('reads a clip step with its own length', async () => {
    query.mockResolvedValueOnce([
      setlistRow({
        item_id: ITEM_ID,
        item_index: '0',
        kind: 'clip',
        clip_id: CLIP_ID.toUpperCase(),
        duration_kind: 'seconds',
        duration_value: 30,
      }),
    ]);
    const read = await reads.readSetlist(SETLIST_ID, {
      kind: 'index',
      index: 2,
      wrapsToFirst: true,
    });
    expect(read?.step).toEqual({
      kind: 'clip',
      itemId: ITEM_ID,
      index: 0,
      clipId: CLIP_ID,
      duration: { kind: 'seconds', value: 30 },
    });
    expect(query).toHaveBeenCalledWith(VJ_STAGE_SETLIST_READ_SQL, [
      SETLIST_ID,
      2,
      'first',
    ]);
  });

  it('passes each read position as its index and mode', async () => {
    query.mockResolvedValue([setlistRow({})]);
    await reads.readSetlist(SETLIST_ID, { kind: 'count' });
    expect(query).toHaveBeenLastCalledWith(VJ_STAGE_SETLIST_READ_SQL, [
      SETLIST_ID,
      null,
      'none',
    ]);
    await reads.readSetlist(SETLIST_ID, { kind: 'last' });
    expect(query).toHaveBeenLastCalledWith(VJ_STAGE_SETLIST_READ_SQL, [
      SETLIST_ID,
      null,
      'last',
    ]);
    await reads.readSetlist(SETLIST_ID, {
      kind: 'index',
      index: 99,
      wrapsToFirst: false,
    });
    expect(query).toHaveBeenLastCalledWith(VJ_STAGE_SETLIST_READ_SQL, [
      SETLIST_ID,
      99,
      'none',
    ]);
  });

  it('keeps the step index inside an int for an index no set list can hold', async () => {
    query.mockResolvedValue([setlistRow({})]);
    for (const index of [100, 3_000_000_000]) {
      await reads.readSetlist(SETLIST_ID, {
        kind: 'index',
        index,
        wrapsToFirst: false,
      });
      expect(query).toHaveBeenLastCalledWith(VJ_STAGE_SETLIST_READ_SQL, [
        SETLIST_ID,
        null,
        'none',
      ]);
      await reads.readSetlist(SETLIST_ID, {
        kind: 'index',
        index,
        wrapsToFirst: true,
      });
      expect(query).toHaveBeenLastCalledWith(VJ_STAGE_SETLIST_READ_SQL, [
        SETLIST_ID,
        0,
        'none',
      ]);
    }
    for (const index of [-1, 1.5, Number.NaN]) {
      await reads.readSetlist(SETLIST_ID, {
        kind: 'index',
        index,
        wrapsToFirst: true,
      });
      expect(query).toHaveBeenLastCalledWith(VJ_STAGE_SETLIST_READ_SQL, [
        SETLIST_ID,
        null,
        'none',
      ]);
    }
  });

  it('answers no step past the end, with the count in the item ids', async () => {
    query.mockResolvedValueOnce([setlistRow({})]);
    await expect(
      reads.readSetlist(SETLIST_ID, {
        kind: 'index',
        index: 2,
        wrapsToFirst: false,
      }),
    ).resolves.toEqual({
      setlistId: SETLIST_ID,
      isLooping: true,
      stepDuration: { kind: 'beats', value: 16 },
      itemIds: [OTHER_ITEM_ID, ITEM_ID],
      step: null,
    });

    query.mockResolvedValueOnce([
      setlistRow({ item_ids: [], is_looping: false }),
    ]);
    await expect(
      reads.readSetlist(SETLIST_ID, { kind: 'count' }),
    ).resolves.toMatchObject({ isLooping: false, itemIds: [], step: null });
  });

  it('reads a stored length out of bounds as the sequence default, and a bad default as 8 seconds', async () => {
    query.mockResolvedValueOnce([
      setlistRow({
        item_id: ITEM_ID,
        item_index: 0,
        kind: 'clip',
        clip_id: CLIP_ID,
        duration_kind: 'seconds',
        duration_value: 601,
      }),
    ]);
    const outOfBounds = await reads.readSetlist(SETLIST_ID, {
      kind: 'index',
      index: 0,
      wrapsToFirst: false,
    });
    expect(outOfBounds?.step?.duration).toEqual({ kind: 'beats', value: 16 });

    query.mockResolvedValueOnce([
      setlistRow({
        step_duration_kind: 'bars',
        step_duration_value: 4,
        item_id: ITEM_ID,
        item_index: 0,
        kind: 'clip',
        clip_id: CLIP_ID,
        duration_kind: 'beats',
        duration_value: 12,
      }),
    ]);
    const badDefault = await reads.readSetlist(SETLIST_ID, {
      kind: 'index',
      index: 0,
      wrapsToFirst: false,
    });
    expect(badDefault?.stepDuration).toEqual(DEFAULT_VJ_STEP_DURATION);
    expect(badDefault?.step?.duration).toEqual(DEFAULT_VJ_STEP_DURATION);

    query.mockResolvedValueOnce([
      setlistRow({
        step_duration_kind: 'seconds',
        step_duration_value: '12',
        item_id: ITEM_ID,
        item_index: 0,
        kind: 'scene',
        scene_id: SCENE_ID,
        duration_kind: 'beats',
        duration_value: '32',
      }),
    ]);
    const textNumbers = await reads.readSetlist(SETLIST_ID, {
      kind: 'index',
      index: 0,
      wrapsToFirst: false,
    });
    expect(textNumbers?.stepDuration).toEqual({ kind: 'seconds', value: 12 });
    expect(textNumbers?.step?.duration).toEqual({ kind: 'beats', value: 32 });
  });

  it('answers null for a set list gone and skips the query for a malformed id', async () => {
    query.mockResolvedValueOnce([]);
    await expect(
      reads.readSetlist(SETLIST_ID, { kind: 'count' }),
    ).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);

    await expect(
      reads.readSetlist(MALFORMED_ID, { kind: 'last' }),
    ).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reads the set list SQL in one statement with every column the contract names', () => {
    for (const fragment of [
      'SELECT "setlist"."is_looping", "setlist"."step_duration_kind", "setlist"."step_duration_value"',
      'array_agg("listed_item"."id"::text ORDER BY "listed_item"."position", "listed_item"."id")',
      'ARRAY[]::text[]',
      '"item"."id" AS "item_id", "item"."item_index", "item"."kind", "item"."scene_id", "item"."clip_id", "item"."duration_kind", "item"."duration_value", "scene"."look"',
      'LEFT JOIN LATERAL (',
      '(ROW_NUMBER() OVER (ORDER BY "indexed_item"."position", "indexed_item"."id") - 1)::int AS "item_index"',
      '(COUNT(*) OVER ())::int AS "item_count"',
      `WHERE "ranked"."item_index" = CASE WHEN $3::text = 'last' THEN "ranked"."item_count" - 1 WHEN $2::int IS NULL THEN -1 WHEN $2::int < "ranked"."item_count" THEN $2::int WHEN $3::text = 'first' THEN 0 ELSE -1 END`,
      'LEFT JOIN "vj_scenes" "scene" ON "scene"."id" = "item"."scene_id"',
      'WHERE "setlist"."id" = $1::uuid',
    ]) {
      expect(VJ_STAGE_SETLIST_READ_SQL).toContain(fragment);
    }
    expect(VJ_STAGE_SETLIST_FOLLOW_SQL).toContain(
      'array_agg("item"."id"::text ORDER BY "item"."position", "item"."id")',
    );
    expect(VJ_STAGE_SETLIST_FOLLOW_SQL).toContain(
      'FROM "vj_setlists" "setlist" WHERE "setlist"."id" = $1::uuid',
    );
    expect(VJ_STAGE_SETLIST_READ_SQL).not.toContain(';');
    expect(VJ_STAGE_SETLIST_FOLLOW_SQL).not.toContain(';');
  });

  it('reads a set list follow: Loop and item ids lowercased, null when gone', async () => {
    query.mockResolvedValueOnce([
      {
        is_looping: true,
        item_ids: [ITEM_ID.toUpperCase(), OTHER_ITEM_ID],
      },
    ]);
    await expect(
      reads.readSetlistFollow(SETLIST_ID.toUpperCase()),
    ).resolves.toEqual({ itemIds: [ITEM_ID, OTHER_ITEM_ID], isLooping: true });
    expect(query).toHaveBeenCalledWith(VJ_STAGE_SETLIST_FOLLOW_SQL, [
      SETLIST_ID,
    ]);

    query.mockResolvedValueOnce([{ is_looping: false, item_ids: [] }]);
    await expect(reads.readSetlistFollow(SETLIST_ID)).resolves.toEqual({
      itemIds: [],
      isLooping: false,
    });

    query.mockResolvedValueOnce([]);
    await expect(reads.readSetlistFollow(SETLIST_ID)).resolves.toBeNull();

    await expect(reads.readSetlistFollow(MALFORMED_ID)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
  });
});

/** One `VJ_STAGE_SETLIST_READ_SQL` row: a looping set list of two items on
 *  16 beats, with no step unless the overrides add one. */
function setlistRow(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    is_looping: true,
    step_duration_kind: 'beats',
    step_duration_value: 16,
    item_ids: [OTHER_ITEM_ID.toUpperCase(), ITEM_ID],
    item_id: null,
    item_index: null,
    kind: null,
    scene_id: null,
    clip_id: null,
    duration_kind: null,
    duration_value: null,
    look: null,
    ...overrides,
  };
}
