import {
  BanEvasionSignalDTO,
  BanEvasionSignalKind,
  scoreSignals,
  tierForScore,
  toBanEvasionAssessment,
} from './ban-evasion-response';
import { RemovalKind } from './entities/removed-account-signal.entity';

function signal(
  kind: BanEvasionSignalKind,
  removedAccountSlug: string | null = 'removed-one',
): BanEvasionSignalDTO {
  return {
    kind,
    removalKind: RemovalKind.PlatformBan,
    removedAt: '2026-06-01T00:00:00.000Z',
    removedAccountName: removedAccountSlug ? 'Removed Account' : null,
    removedAccountSlug,
    communityName: null,
  };
}

describe('ban evasion scoring', () => {
  it('reports no tier when nothing correlates', () => {
    expect(toBanEvasionAssessment('subject', [])).toEqual({
      subjectId: 'subject',
      tier: 'none',
      score: 0,
      signals: [],
    });
  });

  it('puts an identifier match on its own at the high tier', () => {
    const assessment = toBanEvasionAssessment('subject', [
      signal('sign_in_identifier_match'),
    ]);
    expect(assessment.tier).toBe('high');
  });

  it('keeps lineage on its own below the high tier', () => {
    expect(tierForScore(scoreSignals([signal('inviter_removed')]))).toBe(
      'medium',
    );
    expect(
      tierForScore(scoreSignals([signal('reference_of_removed_account')])),
    ).toBe('low');
  });

  it('counts a repeated kind once, however many removed accounts raise it', () => {
    const repeated = scoreSignals([
      signal('inviter_of_removed_account', 'removed-one'),
      signal('inviter_of_removed_account', 'removed-two'),
      signal('inviter_of_removed_account', null),
    ]);
    expect(repeated).toBe(scoreSignals([signal('inviter_of_removed_account')]));
  });

  it('adds distinct kinds together', () => {
    const assessment = toBanEvasionAssessment('subject', [
      signal('stated_details_match'),
      signal('reference_removed'),
    ]);
    expect(assessment.score).toBe(50);
    expect(assessment.tier).toBe('medium');
  });
});
