import {
  createVjStageState,
  vjBeatMs,
  type VjScreenMicReport,
  type VjStageState,
  type VjTempo,
} from '../vj.contract';
import type { VjRuleContext } from './vj-rule-kit';
import {
  adoptVjMicTempo,
  restoredVjTempo,
  ruleSetTempo,
} from './vj-tempo-rules';

const STAGE_EPOCH = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const NOW = 1_800_000_000_000;

/** A stage whose grid has a "1" on NOW at 120 BPM (500 ms beats, 2000 ms bars). */
function stageWithTempo(tempo: Partial<VjTempo> = {}): VjStageState {
  const state = createVjStageState(STAGE_EPOCH, NOW);
  return {
    ...state,
    tempo: {
      bpm: 120,
      downbeatAt: NOW,
      quantize: 'off',
      source: 'manual',
      ...tempo,
    },
  };
}

function contextWith(overrides: Partial<VjRuleContext> = {}): VjRuleContext {
  return {
    now: NOW,
    lookups: null,
    connectedScreenIds: new Set<string>(),
    isLeadMicOn: true,
    ...overrides,
  };
}

function commandPayload(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return { clientId: CLIENT_ID, commandSequence: 1, ...fields };
}

function failureCodeOf(
  fields: Record<string, unknown>,
  context: VjRuleContext = contextWith(),
): string | null {
  const result = ruleSetTempo(
    stageWithTempo(),
    commandPayload(fields),
    context,
  );
  return result.failure === null ? null : result.failure.code;
}

function acceptedTempoOf(
  state: VjStageState,
  fields: Record<string, unknown>,
  context: VjRuleContext = contextWith(),
): VjTempo {
  const result = ruleSetTempo(state, commandPayload(fields), context);
  if (result.accepted === null) {
    throw new Error(`refused with ${result.failure.code}`);
  }
  return result.accepted.nextState.tempo;
}

function micReport(overrides: Partial<VjScreenMicReport>): VjScreenMicReport {
  return { level: 0.5, bpm: 120, confidence: 0.9, beatAt: NOW, ...overrides };
}

describe('stage:setTempo', () => {
  it('checks a tempo patch in the contract order', () => {
    expect(failureCodeOf({})).toBe('vj_patch_empty');
    expect(failureCodeOf({ quantize: undefined })).toBe('vj_patch_empty');
    expect(failureCodeOf({ bpm: 59.9, downbeatAt: NOW + 60_001 })).toBe(
      'vj_bpm_out_of_range',
    );
    expect(failureCodeOf({ bpm: 200.1 })).toBe('vj_bpm_out_of_range');
    expect(failureCodeOf({ bpm: '120' })).toBe('vj_bpm_out_of_range');
    expect(failureCodeOf({ bpm: Number.NaN })).toBe('vj_bpm_out_of_range');
    expect(failureCodeOf({ downbeatAt: NOW + 60_001 })).toBe(
      'vj_downbeat_out_of_range',
    );
    expect(failureCodeOf({ downbeatAt: NOW - 60_001 })).toBe(
      'vj_downbeat_out_of_range',
    );
    expect(failureCodeOf({ downbeatAt: NOW + 0.5 })).toBe(
      'vj_downbeat_out_of_range',
    );
    expect(failureCodeOf({ downbeatAt: NOW - 60_000 })).toBeNull();
    expect(failureCodeOf({ quantize: 'half', source: 'midi' })).toBe(
      'vj_quantize_invalid',
    );
    expect(failureCodeOf({ source: 'midi' })).toBe('vj_tempo_source_invalid');
    expect(failureCodeOf({ source: 'mic', bpm: 128 })).toBe(
      'vj_tempo_source_conflict',
    );
    expect(failureCodeOf({ source: 'mic', downbeatAt: NOW })).toBe(
      'vj_tempo_source_conflict',
    );
    expect(
      failureCodeOf({ source: 'mic' }, contextWith({ isLeadMicOn: false })),
    ).toBe('vj_mic_unavailable');
    expect(failureCodeOf({ source: 'mic' })).toBeNull();
  });

  it('checks isImmediate after the field rules', () => {
    expect(failureCodeOf({ bpm: 300, isImmediate: true })).toBe(
      'vj_bpm_out_of_range',
    );
    expect(failureCodeOf({ bpm: 128, isImmediate: true })).toBe(
      'vj_immediate_not_allowed',
    );
    expect(failureCodeOf({ bpm: 128, isImmediate: 'yes' })).toBe(
      'vj_effect_flag_invalid',
    );
    const result = ruleSetTempo(
      stageWithTempo(),
      commandPayload({ bpm: 128, isImmediate: false }),
      contextWith(),
    );
    expect(result.accepted?.isImmediate).toBe(false);
    expect(result.accepted?.isLookSwitch).toBe(false);
    expect(result.accepted?.lookups).toEqual([]);
  });

  it('re-anchors the downbeat on a bpm change so the bar does not jump', () => {
    const state = stageWithTempo();
    const fiveBarsAndABeat = NOW + 5 * 2000 + 500;
    const tempo = acceptedTempoOf(
      state,
      { bpm: 100 },
      contextWith({ now: fiveBarsAndABeat }),
    );
    expect(tempo).toEqual({
      bpm: 100,
      downbeatAt: NOW + 5 * 2000,
      quantize: 'off',
      source: 'manual',
    });
  });

  it('keeps the bpm when only the downbeat moves', () => {
    const tempo = acceptedTempoOf(stageWithTempo({ bpm: 97.5 }), {
      downbeatAt: NOW + 1234,
    });
    expect(tempo.bpm).toBe(97.5);
    expect(tempo.downbeatAt).toBe(NOW + 1234);
  });

  it('sets source manual for a bare bpm and keeps it for a quantize toggle', () => {
    const tapState = stageWithTempo({ source: 'tap' });
    expect(acceptedTempoOf(tapState, { bpm: 128 }).source).toBe('manual');
    expect(acceptedTempoOf(tapState, { downbeatAt: NOW }).source).toBe(
      'manual',
    );
    expect(
      acceptedTempoOf(tapState, { bpm: 128, downbeatAt: NOW, source: 'tap' })
        .source,
    ).toBe('tap');
    const micState = stageWithTempo({ source: 'mic' });
    expect(acceptedTempoOf(micState, { quantize: 'bar' })).toEqual({
      ...micState.tempo,
      quantize: 'bar',
    });
    expect(acceptedTempoOf(stageWithTempo(), { source: 'mic' })).toEqual({
      ...stageWithTempo().tempo,
      source: 'mic',
    });
  });

  it('stores bpm rounded to one decimal', () => {
    expect(acceptedTempoOf(stageWithTempo(), { bpm: 127.96 }).bpm).toBe(128);
    expect(acceptedTempoOf(stageWithTempo(), { bpm: 99.44 }).bpm).toBe(99.4);
  });

  it('leaves every other part of the stage alone', () => {
    const state = stageWithTempo();
    const result = ruleSetTempo(
      state,
      commandPayload({ quantize: 'beat' }),
      contextWith(),
    );
    expect(result.accepted?.nextState).toEqual({
      ...state,
      tempo: { ...state.tempo, quantize: 'beat' },
    });
  });
});

describe('mic tempo adoption', () => {
  const micTempo = stageWithTempo({ source: 'mic' }).tempo;

  it('adopts a confident mic tempo and keeps the bar position', () => {
    const beatOnThree = NOW + 4 * 2000 + 2 * 500;
    const adopted = adoptVjMicTempo(
      micTempo,
      micReport({ bpm: 125.04, beatAt: beatOnThree }),
      null,
      beatOnThree + 100,
    );
    expect(adopted).toEqual({
      bpm: 125,
      downbeatAt: Math.round(beatOnThree - 2 * vjBeatMs(125)),
      quantize: 'off',
      source: 'mic',
    });
  });

  it('moves to the next beat when the phase is half or more', () => {
    const lateInBeatFour = NOW + 3 * 500 + 300;
    const adopted = adoptVjMicTempo(
      micTempo,
      micReport({ bpm: 120, beatAt: lateInBeatFour }),
      null,
      lateInBeatFour,
    );
    expect(adopted?.downbeatAt).toBe(lateInBeatFour);
    const earlyInBeatTwo = NOW + 500 + 100;
    const earlyAdopted = adoptVjMicTempo(
      micTempo,
      micReport({ bpm: 120, beatAt: earlyInBeatTwo }),
      null,
      earlyInBeatTwo,
    );
    expect(earlyAdopted?.downbeatAt).toBe(earlyInBeatTwo - 500);
  });

  it('skips adoption below confidence 0.6, within 2 s, or for a change under 0.5 BPM and 40 ms', () => {
    const offBeat = NOW + 100;
    expect(
      adoptVjMicTempo(
        micTempo,
        micReport({ confidence: 0.59, beatAt: offBeat }),
        null,
        NOW,
      ),
    ).toBeNull();
    expect(
      adoptVjMicTempo(
        micTempo,
        micReport({ confidence: 0.6, beatAt: offBeat }),
        null,
        NOW,
      ),
    ).not.toBeNull();
    expect(
      adoptVjMicTempo(
        micTempo,
        micReport({ beatAt: offBeat }),
        NOW - 1999,
        NOW,
      ),
    ).toBeNull();
    expect(
      adoptVjMicTempo(
        micTempo,
        micReport({ beatAt: offBeat }),
        NOW - 2000,
        NOW,
      ),
    ).not.toBeNull();
    expect(
      adoptVjMicTempo(
        micTempo,
        micReport({ bpm: 120.4, beatAt: NOW + 500 + 39 }),
        null,
        NOW,
      ),
    ).toBeNull();
    expect(
      adoptVjMicTempo(
        micTempo,
        micReport({ bpm: 120.4, beatAt: NOW + 500 - 39 }),
        null,
        NOW,
      ),
    ).toBeNull();
    expect(
      adoptVjMicTempo(
        micTempo,
        micReport({ bpm: 120.5, beatAt: NOW + 500 }),
        null,
        NOW,
      ),
    ).not.toBeNull();
    expect(
      adoptVjMicTempo(
        micTempo,
        micReport({ bpm: 120, beatAt: NOW + 500 + 40 }),
        null,
        NOW,
      ),
    ).not.toBeNull();
  });

  it('skips adoption unless the source is mic', () => {
    const report = micReport({ bpm: 130, beatAt: NOW + 100 });
    for (const source of ['manual', 'tap'] as const) {
      expect(
        adoptVjMicTempo({ ...micTempo, source }, report, null, NOW),
      ).toBeNull();
    }
    expect(
      adoptVjMicTempo(micTempo, micReport({ bpm: null }), null, NOW),
    ).toBeNull();
    expect(
      adoptVjMicTempo(micTempo, micReport({ beatAt: null }), null, NOW),
    ).toBeNull();
  });
});

describe('restored tempo', () => {
  const defaults: VjTempo = {
    bpm: 124,
    downbeatAt: NOW,
    quantize: 'off',
    source: 'manual',
  };

  it('keeps the phase of a valid restored tempo', () => {
    const anHourAgo = NOW - 3_600_000;
    expect(
      restoredVjTempo(
        { bpm: 128.04, downbeatAt: anHourAgo, quantize: 'bar', source: 'mic' },
        defaults,
      ),
    ).toEqual({
      bpm: 128,
      downbeatAt: anHourAgo,
      quantize: 'bar',
      source: 'mic',
    });
  });

  it('takes the default for each invalid part', () => {
    expect(
      restoredVjTempo(
        { bpm: 40, downbeatAt: 1.5, quantize: 'half', source: 'midi' },
        defaults,
      ),
    ).toEqual(defaults);
    expect(restoredVjTempo(null, defaults)).toEqual(defaults);
    expect(restoredVjTempo('fast', defaults)).not.toBe(defaults);
  });
});
