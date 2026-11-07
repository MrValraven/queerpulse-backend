import { randomUUID } from 'node:crypto';
import { createVjStageState, VJ_REMOTE_COMMAND_NAMES } from '../vj.contract';
import {
  isSameVjLookupList,
  ruleForVjCommand,
  VJ_REMOTE_COMMAND_RULES,
  VJ_SELF_STALE_CHECKED_COMMANDS,
} from './vj-command-rules';
import { ruleSetEffects } from './vj-effects-rules';
import { ruleSetPack } from './vj-source-rules';
import type { VjRuleContext } from './vj-rule-kit';

const PREPARE_CONTEXT: VjRuleContext = {
  now: 1000,
  lookups: null,
  connectedScreenIds: new Set<string>(),
  isLeadMicOn: false,
};

describe('vj-command-rules', () => {
  it('maps every remote command name to a rule', () => {
    expect(Object.keys(VJ_REMOTE_COMMAND_RULES)).toEqual([
      ...VJ_REMOTE_COMMAND_NAMES,
    ]);
    for (const name of VJ_REMOTE_COMMAND_NAMES) {
      expect(typeof VJ_REMOTE_COMMAND_RULES[name]).toBe('function');
    }
    expect(VJ_REMOTE_COMMAND_RULES['stage:setPack']).toBe(ruleSetPack);
    expect(VJ_REMOTE_COMMAND_RULES['stage:setEffects']).toBe(ruleSetEffects);
  });

  it('runs the named rule against the state', () => {
    const state = createVjStageState(randomUUID(), 1000);
    const refused = ruleForVjCommand(
      'stage:setEffects',
      state,
      {},
      PREPARE_CONTEXT,
    );
    expect(refused.failure?.code).toBe('vj_patch_empty');
    const packId = randomUUID();
    const accepted = ruleForVjCommand(
      'stage:setPack',
      state,
      { packId },
      PREPARE_CONTEXT,
    );
    expect(accepted.accepted?.lookups).toEqual([{ kind: 'pack', packId }]);
  });

  it('leaves the stale check of the two set list steps to their rules', () => {
    expect([...VJ_SELF_STALE_CHECKED_COMMANDS]).toEqual([
      'stage:setlistNext',
      'stage:setlistPrevious',
    ]);
  });

  it('compares lookup lists by their reads in any order and case', () => {
    const packId = randomUUID();
    const otherPackId = randomUUID();
    const clipIds = [randomUUID(), randomUUID()];
    expect(isSameVjLookupList([], [])).toBe(true);
    expect(
      isSameVjLookupList(
        [
          { kind: 'pack', packId },
          { kind: 'clipsInPack', packId, clipIds },
        ],
        [
          {
            kind: 'clipsInPack',
            packId: packId.toUpperCase(),
            clipIds: [...clipIds].reverse(),
          },
          { kind: 'pack', packId },
        ],
      ),
    ).toBe(true);
    expect(
      isSameVjLookupList(
        [{ kind: 'clipsInPack', packId, clipIds }],
        [{ kind: 'clipsInPack', packId: otherPackId, clipIds }],
      ),
    ).toBe(false);
    expect(
      isSameVjLookupList(
        [{ kind: 'setlistItem', setlistId: packId, index: null }],
        [{ kind: 'setlistItem', setlistId: packId, index: 0 }],
      ),
    ).toBe(false);
    expect(isSameVjLookupList([{ kind: 'pack', packId }], [])).toBe(false);
  });
});
