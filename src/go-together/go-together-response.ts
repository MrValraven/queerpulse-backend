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
  /** Ids of the current host questions a waiting member has no usable answer
   *  to, because the host changed or added them after this member opted in.
   *  The card asks for these again through
   *  `PUT /events/:slug/go-together/host-answers`. Empty in every other
   *  state. */
  unansweredHostQuestionIds: string[];
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
