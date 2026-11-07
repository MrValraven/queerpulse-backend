import { createVjStageState, VJ_LIMITS } from '../vj.contract';
import {
  acceptRule,
  EMPTY_VJ_LOOKUP_RESULTS,
  hasAnyField,
  hasControlCharacter,
  hasExactlyKeys,
  isFiniteInRange,
  isOneOf,
  isRecord,
  isSafeIntegerInRange,
  isUuidString,
  readNullableUuid,
  readVjImmediateFlag,
  refuseRule,
  roundToTenth,
  vjPackClipKey,
  vjSetlistItemKey,
  withVjLiveSource,
  withVjRecentClip,
} from './vj-rule-kit';

const STAGE_EPOCH = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;
const CLIP_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_CLIP_ID = '33333333-3333-4333-8333-333333333333';
const PACK_ID = '44444444-4444-4444-8444-444444444444';
const SETLIST_ID = '55555555-5555-4555-8555-555555555555';
const UPPERCASE_ID = 'ABCDEF01-2345-4678-89AB-CDEF01234567';

function clipIdAt(position: number): string {
  return `00000000-0000-4000-8000-${String(position).padStart(12, '0')}`;
}

describe('vj rule kit', () => {
  it('reads uuids lowercased and refuses other values', () => {
    expect(readNullableUuid(UPPERCASE_ID)).toEqual({
      isValid: true,
      id: UPPERCASE_ID.toLowerCase(),
    });
    expect(readNullableUuid(null)).toEqual({ isValid: true, id: null });
    for (const value of [
      undefined,
      '',
      'x',
      42,
      {},
      [CLIP_ID],
      `${CLIP_ID} `,
    ]) {
      expect(readNullableUuid(value)).toEqual({ isValid: false, id: null });
    }
    expect(isUuidString(CLIP_ID)).toBe(true);
    expect(isUuidString(null)).toBe(false);
    expect(isUuidString('not-a-uuid')).toBe(false);
  });

  it('checks exact key sets', () => {
    expect(hasExactlyKeys({ unit: 'ms', value: 800 }, ['value', 'unit'])).toBe(
      true,
    );
    expect(
      hasExactlyKeys({ unit: 'ms', value: 800, extra: true }, [
        'unit',
        'value',
      ]),
    ).toBe(false);
    expect(hasExactlyKeys({ unit: 'ms' }, ['unit', 'value'])).toBe(false);
    expect(hasExactlyKeys({ unit: 'ms', other: 1 }, ['unit', 'value'])).toBe(
      false,
    );
    expect(hasExactlyKeys({}, [])).toBe(true);
  });

  it('finds control characters including line and paragraph separators', () => {
    expect(hasControlCharacter('Hello dancefloor')).toBe(false);
    expect(hasControlCharacter('Ola, pista')).toBe(false);
    for (const codePoint of [
      0x00, 0x0a, 0x1f, 0x7f, 0x85, 0x9f, 0x2028, 0x2029,
    ]) {
      expect(hasControlCharacter(`a${String.fromCodePoint(codePoint)}b`)).toBe(
        true,
      );
    }
    expect(hasControlCharacter(String.fromCodePoint(0xa0))).toBe(false);
  });

  it('puts a live clip first in history once and keeps eight', () => {
    expect(withVjRecentClip([], CLIP_ID)).toEqual([CLIP_ID]);
    expect(withVjRecentClip([SECOND_CLIP_ID, CLIP_ID], CLIP_ID)).toEqual([
      CLIP_ID,
      SECOND_CLIP_ID,
    ]);
    const fullHistory = Array.from(
      { length: VJ_LIMITS.recentClipsMax },
      (_unused, position) => clipIdAt(position),
    );
    const nextHistory = withVjRecentClip(fullHistory, CLIP_ID);
    expect(nextHistory).toHaveLength(8);
    expect(nextHistory[0]).toBe(CLIP_ID);
    expect(nextHistory).not.toContain(clipIdAt(7));
  });

  it('switches the live source and clears the other kind', () => {
    const initialState = createVjStageState(STAGE_EPOCH, NOW);

    const clipState = withVjLiveSource(initialState, {
      kind: 'clip',
      clipId: CLIP_ID,
    });
    expect(clipState.liveClipId).toBe(CLIP_ID);
    expect(clipState.liveGeneratorId).toBeNull();
    expect(clipState.liveGeneratorVariant).toBeNull();
    expect(clipState.clipSequence).toBe(initialState.clipSequence + 1);
    expect(clipState.recentClipIds).toEqual([CLIP_ID]);
    expect(clipState.liveSince).toBe(initialState.liveSince);

    const generatorState = withVjLiveSource(clipState, {
      kind: 'generator',
      generatorId: 'prideFlagWave',
      generatorVariant: 'trans',
    });
    expect(generatorState.liveClipId).toBeNull();
    expect(generatorState.liveGeneratorId).toBe('prideFlagWave');
    expect(generatorState.liveGeneratorVariant).toBe('trans');
    expect(generatorState.clipSequence).toBe(clipState.clipSequence + 1);
    expect(generatorState.recentClipIds).toEqual([CLIP_ID]);

    const blackState = withVjLiveSource(generatorState, null);
    expect(blackState.liveClipId).toBeNull();
    expect(blackState.liveGeneratorId).toBeNull();
    expect(blackState.liveGeneratorVariant).toBeNull();
    expect(blackState.clipSequence).toBe(generatorState.clipSequence + 1);
    expect(blackState.recentClipIds).toEqual([CLIP_ID]);

    expect(initialState.liveClipId).toBeNull();
    expect(initialState.recentClipIds).toEqual([]);
  });

  it('accepts isImmediate on exactly the three commands', () => {
    expect(
      readVjImmediateFlag('stage:setEffects', {
        isBlackout: true,
        isImmediate: true,
      }),
    ).toEqual({ code: null, isImmediate: true });
    expect(
      readVjImmediateFlag('stage:setEffects', {
        isBlackout: true,
        speed: 2,
        isImmediate: true,
      }),
    ).toEqual({ code: 'vj_immediate_not_allowed', isImmediate: false });
    expect(
      readVjImmediateFlag('stage:setEffects', {
        settings: {},
        isImmediate: true,
      }),
    ).toEqual({ code: 'vj_immediate_not_allowed', isImmediate: false });
    expect(
      readVjImmediateFlag('stage:setStrobe', {
        isStrobing: false,
        isImmediate: true,
      }),
    ).toEqual({ code: null, isImmediate: true });
    expect(
      readVjImmediateFlag('stage:setStrobe', {
        isStrobing: true,
        isImmediate: true,
      }),
    ).toEqual({ code: 'vj_immediate_not_allowed', isImmediate: false });
    expect(
      readVjImmediateFlag('stage:resetLook', { isImmediate: true }),
    ).toEqual({ code: null, isImmediate: true });
    expect(
      readVjImmediateFlag('stage:goClip', {
        clipId: CLIP_ID,
        isImmediate: true,
      }),
    ).toEqual({ code: 'vj_immediate_not_allowed', isImmediate: false });
    expect(
      readVjImmediateFlag('stage:resetLook', { isImmediate: 'yes' }),
    ).toEqual({ code: 'vj_effect_flag_invalid', isImmediate: false });
    expect(
      readVjImmediateFlag('stage:setEffects', {
        isBlackout: true,
        isImmediate: null,
      }),
    ).toEqual({ code: 'vj_effect_flag_invalid', isImmediate: false });
    expect(readVjImmediateFlag('stage:goClip', { clipId: CLIP_ID })).toEqual({
      code: null,
      isImmediate: false,
    });
    expect(
      readVjImmediateFlag('stage:goClip', {
        clipId: CLIP_ID,
        isImmediate: false,
      }),
    ).toEqual({ code: null, isImmediate: false });
  });

  it('builds refusals with the code and the optional state', () => {
    const state = createVjStageState(STAGE_EPOCH, NOW);
    const plainRefusal = refuseRule('vj_clip_not_found');
    expect(plainRefusal.accepted).toBeNull();
    expect(plainRefusal.failure).toMatchObject({
      ok: false,
      code: 'vj_clip_not_found',
    });
    expect(plainRefusal.failure).not.toHaveProperty('state');
    expect(refuseRule('vj_stale_setlist', state).failure?.state).toBe(state);
  });

  it('fills accepted change options with their defaults', () => {
    const state = createVjStageState(STAGE_EPOCH, NOW);
    expect(acceptRule(state)).toEqual({
      failure: null,
      accepted: {
        nextState: state,
        lookups: [],
        isImmediate: false,
        isLookSwitch: false,
        overlayHideAfterMs: undefined,
      },
    });
    const lookups = [{ kind: 'pack' as const, packId: PACK_ID }];
    expect(
      acceptRule(state, {
        lookups,
        isImmediate: true,
        isLookSwitch: true,
        overlayHideAfterMs: null,
      }).accepted,
    ).toEqual({
      nextState: state,
      lookups,
      isImmediate: true,
      isLookSwitch: true,
      overlayHideAfterMs: null,
    });
  });

  it('keys pack clips and set list items lowercased', () => {
    expect(vjPackClipKey(PACK_ID.toUpperCase(), CLIP_ID)).toBe(
      vjPackClipKey(PACK_ID, CLIP_ID.toUpperCase()),
    );
    expect(vjPackClipKey(PACK_ID, CLIP_ID)).not.toBe(
      vjPackClipKey(PACK_ID, SECOND_CLIP_ID),
    );
    expect(vjSetlistItemKey(SETLIST_ID.toUpperCase(), 0)).toBe(
      vjSetlistItemKey(SETLIST_ID, 0),
    );
    expect(vjSetlistItemKey(SETLIST_ID, null)).not.toBe(
      vjSetlistItemKey(SETLIST_ID, 0),
    );
  });

  it('starts with empty lookup results', () => {
    expect(EMPTY_VJ_LOOKUP_RESULTS.packs.size).toBe(0);
    expect(EMPTY_VJ_LOOKUP_RESULTS.existingClipIds.size).toBe(0);
    expect(EMPTY_VJ_LOOKUP_RESULTS.clipIdsInPack.size).toBe(0);
    expect(EMPTY_VJ_LOOKUP_RESULTS.packClips.size).toBe(0);
    expect(EMPTY_VJ_LOOKUP_RESULTS.scenes.size).toBe(0);
    expect(EMPTY_VJ_LOOKUP_RESULTS.setlistItems.size).toBe(0);
  });

  it('checks numbers against inclusive ranges', () => {
    expect(isSafeIntegerInRange(60, 60, 200)).toBe(true);
    expect(isSafeIntegerInRange(200, 60, 200)).toBe(true);
    expect(isSafeIntegerInRange(60.5, 60, 200)).toBe(false);
    expect(isSafeIntegerInRange(201, 60, 200)).toBe(false);
    expect(isSafeIntegerInRange('100', 60, 200)).toBe(false);
    expect(isFiniteInRange(0.5, 0, 1)).toBe(true);
    expect(isFiniteInRange(Number.NaN, 0, 1)).toBe(false);
    expect(isFiniteInRange(Number.POSITIVE_INFINITY, 0, 1)).toBe(false);
    expect(isFiniteInRange(1.01, 0, 1)).toBe(false);
    expect(roundToTenth(123.456)).toBe(123.5);
    expect(roundToTenth(123.44)).toBe(123.4);
  });

  it('reads records, list members and present fields', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isOneOf(['ms', 'beats'], 'beats')).toBe(true);
    expect(isOneOf(['ms', 'beats'], 'bars')).toBe(false);
    expect(hasAnyField({ speed: undefined, mode: 'cut' }, ['mode'])).toBe(true);
    expect(hasAnyField({ speed: undefined }, ['speed', 'settings'])).toBe(
      false,
    );
  });
});
