import {
  createVjStageState,
  VJ_LIMITS,
  type VjStageState,
} from '../vj.contract';
import {
  EMPTY_VJ_LOOKUP_RESULTS,
  type VjLookupResults,
  type VjRuleContext,
} from './vj-rule-kit';
import {
  applyVjAdvance,
  checkVjAdvance,
  restoredVjShuffle,
  ruleSetShuffle,
  type VjAdvanceCheck,
} from './vj-shuffle-rules';

const STAGE_EPOCH = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;
const PACK_ID = '44444444-4444-4444-8444-444444444444';
const CLIP_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_CLIP_ID = '33333333-3333-4333-8333-333333333333';
const UPPERCASE_CLIP_ID = 'ABCDEF01-2345-4678-89AB-CDEF01234567';

function clipIdAt(position: number): string {
  return `00000000-0000-4000-8000-${String(position).padStart(12, '0')}`;
}

function stageState(overrides: Partial<VjStageState> = {}): VjStageState {
  return { ...createVjStageState(STAGE_EPOCH, NOW), ...overrides };
}

function prepareContext(): VjRuleContext {
  return {
    now: NOW,
    lookups: null,
    connectedScreenIds: new Set<string>(),
    isLeadMicOn: false,
  };
}

function applyContext(clipIdsInPack: readonly string[]): VjRuleContext {
  const lookups: VjLookupResults = {
    ...EMPTY_VJ_LOOKUP_RESULTS,
    clipIdsInPack: new Set(clipIdsInPack),
  };
  return { ...prepareContext(), lookups };
}

function shuffleOnState(overrides: Partial<VjStageState> = {}): VjStageState {
  const base = stageState({ activePackId: PACK_ID, clipSequence: 5 });
  return {
    ...base,
    shuffle: { ...base.shuffle, isOn: true },
    ...overrides,
  };
}

function acceptedCheck(
  check: VjAdvanceCheck,
): Extract<VjAdvanceCheck, { failure: null }> {
  if (check.failure !== null) {
    throw new Error(`expected an accepted advance, got ${check.failure.code}`);
  }
  return check;
}

describe('vj shuffle rules', () => {
  it('checks shuffle settings in the contract order', () => {
    const state = stageState();
    const codeOf = (payload: Record<string, unknown>) =>
      ruleSetShuffle(state, payload, prepareContext()).failure?.code ?? null;

    expect(codeOf({})).toBe('vj_patch_empty');
    expect(codeOf({ isImmediate: true })).toBe('vj_patch_empty');
    expect(codeOf({ bpm: 120 })).toBe('vj_patch_empty');
    expect(codeOf({ isOn: 'yes', intervalKind: 'bars', source: 'all' })).toBe(
      'vj_effect_flag_invalid',
    );
    expect(codeOf({ intervalKind: 'bars', source: 'all' })).toBe(
      'vj_shuffle_interval_invalid',
    );
    expect(codeOf({ intervalValue: 61, source: 'all' })).toBe(
      'vj_shuffle_interval_invalid',
    );
    expect(codeOf({ intervalKind: 'beats', intervalValue: 5 })).toBe(
      'vj_shuffle_interval_invalid',
    );
    expect(codeOf({ source: 'all', excludedClipIds: 'x' })).toBe(
      'vj_shuffle_source_invalid',
    );
    expect(codeOf({ excludedClipIds: ['not-a-uuid'] })).toBe(
      'vj_excluded_clips_invalid',
    );
    expect(codeOf({ excludedClipIds: [CLIP_ID], isImmediate: true })).toBe(
      'vj_no_active_pack',
    );
    expect(codeOf({ isOn: true, isImmediate: true })).toBe(
      'vj_immediate_not_allowed',
    );
    expect(codeOf({ isOn: true, isImmediate: 'yes' })).toBe(
      'vj_effect_flag_invalid',
    );
  });

  it('keeps a valid interval on a kind change and takes 8 otherwise', () => {
    const state = stageState();
    const tenSeconds = ruleSetShuffle(
      state,
      { intervalValue: 10 },
      prepareContext(),
    ).accepted?.nextState;
    expect(tenSeconds?.shuffle.intervalValue).toBe(10);
    const beats = ruleSetShuffle(
      tenSeconds ?? state,
      { intervalKind: 'beats' },
      prepareContext(),
    ).accepted?.nextState;
    expect(beats?.shuffle).toMatchObject({
      intervalKind: 'beats',
      intervalValue: VJ_LIMITS.shuffleBeatsDefault,
    });
    const favorites = ruleSetShuffle(
      state,
      { source: 'favorites', isOn: true },
      prepareContext(),
    ).accepted?.nextState;
    expect(favorites?.shuffle).toMatchObject({
      isOn: true,
      source: 'favorites',
    });
  });

  it('stores excluded ids canonical', () => {
    const state = stageState({ activePackId: PACK_ID });
    const payload = {
      excludedClipIds: [
        SECOND_CLIP_ID,
        UPPERCASE_CLIP_ID,
        CLIP_ID,
        SECOND_CLIP_ID.toUpperCase(),
      ],
    };
    const canonical = [
      CLIP_ID,
      SECOND_CLIP_ID,
      UPPERCASE_CLIP_ID.toLowerCase(),
    ].sort();

    const prepared = ruleSetShuffle(state, payload, prepareContext());
    expect(prepared.accepted?.lookups).toEqual([
      { kind: 'clipsInPack', packId: PACK_ID, clipIds: canonical },
    ]);
    const applied = ruleSetShuffle(state, payload, applyContext(canonical));
    expect(applied.failure).toBeNull();
    expect(applied.accepted?.nextState.shuffle.excludedClipIds).toEqual(
      canonical,
    );
  });

  it('empties the excluded list with an empty array and reads nothing', () => {
    const state = stageState({ activePackId: PACK_ID });
    const withExclusions = {
      ...state,
      shuffle: { ...state.shuffle, excludedClipIds: [CLIP_ID] },
    };
    const result = ruleSetShuffle(
      withExclusions,
      { excludedClipIds: [] },
      prepareContext(),
    );
    expect(result.accepted?.lookups).toEqual([]);
    expect(result.accepted?.nextState.shuffle.excludedClipIds).toEqual([]);
    const withoutPack = ruleSetShuffle(
      stageState(),
      { excludedClipIds: [] },
      prepareContext(),
    );
    expect(withoutPack.failure).toBeNull();
  });

  it('refuses 201 excluded ids', () => {
    const state = stageState({ activePackId: PACK_ID });
    const tooMany = Array.from({ length: 201 }, (_unused, position) =>
      clipIdAt(position),
    );
    expect(
      ruleSetShuffle(state, { excludedClipIds: tooMany }, prepareContext())
        .failure?.code,
    ).toBe('vj_excluded_clips_invalid');
    const atLimit = tooMany.slice(0, VJ_LIMITS.excludedClipIdsMax);
    expect(
      ruleSetShuffle(state, { excludedClipIds: atLimit }, prepareContext())
        .failure,
    ).toBeNull();
  });

  it('refuses excluded ids with no active pack', () => {
    const result = ruleSetShuffle(
      stageState(),
      { excludedClipIds: [CLIP_ID] },
      prepareContext(),
    );
    expect(result.failure?.code).toBe('vj_no_active_pack');
    expect(result.failure?.state).toBeUndefined();
  });

  it('refuses an excluded id outside the pack once lookups are given', () => {
    const state = stageState({ activePackId: PACK_ID });
    const payload = { excludedClipIds: [CLIP_ID, SECOND_CLIP_ID] };
    expect(ruleSetShuffle(state, payload, prepareContext()).failure).toBeNull();
    const refused = ruleSetShuffle(state, payload, applyContext([CLIP_ID]));
    expect(refused.failure?.code).toBe('vj_clip_not_in_pack');
    expect(refused.failure?.state).toBeUndefined();
  });

  it('checks an advance in the contract order and carries the state on silent codes', () => {
    const state = shuffleOnState({
      shuffle: {
        ...shuffleOnState().shuffle,
        excludedClipIds: [SECOND_CLIP_ID],
      },
    });
    const payload = { expectedClipSequence: 5, clipId: CLIP_ID };

    const notLead = checkVjAdvance(state, false, payload);
    expect(notLead.failure?.code).toBe('vj_not_lead');
    expect(notLead.failure?.state).toBe(state);
    expect(notLead.lookups).toEqual([]);

    const shuffleOff = {
      ...state,
      shuffle: { ...state.shuffle, isOn: false },
    };
    expect(checkVjAdvance(shuffleOff, true, payload).failure?.code).toBe(
      'vj_shuffle_off',
    );
    const noPack = { ...state, activePackId: null };
    expect(checkVjAdvance(noPack, true, payload).failure?.state).toBe(noPack);
    expect(checkVjAdvance(noPack, true, payload).failure?.code).toBe(
      'vj_no_active_pack',
    );

    const stale = checkVjAdvance(state, true, {
      expectedClipSequence: 4,
      clipId: 'not-a-uuid',
    });
    expect(stale.failure?.code).toBe('vj_stale_clip_sequence');
    expect(stale.failure?.state).toBe(state);

    const malformed = checkVjAdvance(state, true, {
      expectedClipSequence: 5,
      clipId: 'not-a-uuid',
    });
    expect(malformed.failure?.code).toBe('vj_clip_not_in_pack');
    expect(malformed.failure?.state).toBeUndefined();

    const excluded = checkVjAdvance(state, true, {
      expectedClipSequence: 5,
      clipId: SECOND_CLIP_ID.toUpperCase(),
    });
    expect(excluded.failure?.code).toBe('vj_clip_excluded');
    expect(excluded.failure?.state).toBe(state);

    const accepted = acceptedCheck(checkVjAdvance(state, true, payload));
    expect(accepted).toMatchObject({ packId: PACK_ID, clipId: CLIP_ID });
    expect(accepted.lookups).toEqual([
      { kind: 'packClip', packId: PACK_ID, clipId: CLIP_ID },
    ]);
  });

  it('refuses an advance on a clip that left the pack', () => {
    const state = shuffleOnState();
    const check = acceptedCheck(
      checkVjAdvance(state, true, { expectedClipSequence: 5, clipId: CLIP_ID }),
    );
    const result = applyVjAdvance(state, check, null);
    expect(result.failure?.code).toBe('vj_clip_not_in_pack');
    expect(result.failure?.state).toBeUndefined();
  });

  it('refuses a favorites advance on a clip that is no favorite', () => {
    const state = shuffleOnState({
      shuffle: { ...shuffleOnState().shuffle, source: 'favorites' },
    });
    const check = acceptedCheck(
      checkVjAdvance(state, true, { expectedClipSequence: 5, clipId: CLIP_ID }),
    );
    const refused = applyVjAdvance(state, check, { isFavorite: false });
    expect(refused.failure?.code).toBe('vj_clip_not_favorite');
    expect(refused.failure?.state).toBe(state);

    const accepted = applyVjAdvance(state, check, { isFavorite: true });
    expect(accepted.failure).toBeNull();
    expect(accepted.nextState?.liveClipId).toBe(CLIP_ID);
  });

  it('takes any pack clip on a pack shuffle and goes live like goClip', () => {
    const base = shuffleOnState();
    const state = {
      ...base,
      liveGeneratorId: 'plasma' as VjStageState['liveGeneratorId'],
      recentClipIds: [SECOND_CLIP_ID],
    };
    const check = acceptedCheck(
      checkVjAdvance(state, true, { expectedClipSequence: 5, clipId: CLIP_ID }),
    );
    const result = applyVjAdvance(state, check, { isFavorite: false });
    expect(result.nextState).toMatchObject({
      liveClipId: CLIP_ID,
      liveGeneratorId: null,
      liveGeneratorVariant: null,
      clipSequence: 6,
      recentClipIds: [CLIP_ID, SECOND_CLIP_ID],
    });
  });

  it('restores excluded ids only for clips still in the pack', () => {
    const defaults = stageState().shuffle;
    const restored = restoredVjShuffle(
      {
        isOn: true,
        intervalKind: 'beats',
        intervalValue: 16,
        source: 'favorites',
        excludedClipIds: [SECOND_CLIP_ID, 'not-a-uuid', CLIP_ID.toUpperCase()],
      },
      defaults,
      new Set([CLIP_ID]),
    );
    expect(restored).toEqual({
      isOn: true,
      intervalKind: 'beats',
      intervalValue: 16,
      source: 'favorites',
      excludedClipIds: [CLIP_ID],
    });
  });

  it('restores each invalid shuffle field to its default', () => {
    const defaults = stageState().shuffle;
    expect(
      restoredVjShuffle(
        {
          isOn: 'yes',
          intervalKind: 'beats',
          intervalValue: 7,
          source: 'all',
          excludedClipIds: 'x',
          bpm: 128,
        },
        defaults,
        new Set([CLIP_ID]),
      ),
    ).toEqual({
      isOn: false,
      intervalKind: 'beats',
      intervalValue: VJ_LIMITS.shuffleBeatsDefault,
      source: 'pack',
      excludedClipIds: [],
    });
    expect(restoredVjShuffle(null, defaults, new Set())).toEqual(defaults);
  });
});
