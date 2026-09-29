import type { MemberRef } from '../common/member-ref';
import type { CardState } from './go-together-card';
import type { MemberBlocker } from './go-together-eligibility.service';
import type { HostQuestion, Lens } from './go-together-questionnaire.catalog';

export type { CardState };

export interface GoTogetherCardResponse {
  state: CardState;
  ineligibleReason: MemberBlocker | null;
  cutoffAt: string | null;
  optInClosesAt: string;
  hostQuestions: HostQuestion[];
  pair: {
    partner: MemberRef;
    status: 'pending' | 'accepted';
    direction: 'sent' | 'received';
  } | null;
  lens: Lens | null;
  groupId: string | null;
  profile: { exists: boolean; needsRefresh: boolean };
}

export interface HostConfigResponse {
  enabled: boolean;
  cutoffAt: string;
  earliestCutoffAt: string;
  latestCutoffAt: string;
  hostQuestions: HostQuestion[];
  meetingPointNote: string | null;
  /** True once matching has run; the settings can no longer change. */
  isLocked: boolean;
}

export interface HostSummaryResponse {
  waiting: number;
  grouped: number;
  unmatched: number;
  groups: number;
}
