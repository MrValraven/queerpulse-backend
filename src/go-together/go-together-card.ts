import type { EventMatchEntry } from './entities/event-match-entry.entity';
import type {
  EventBlocker,
  MemberBlocker,
} from './go-together-eligibility.service';

export type CardState =
  | 'unavailable'
  | 'ineligible'
  | 'pairInvite'
  | 'notOptedIn'
  | 'questionnaireNeeded'
  | 'waiting'
  | 'grouped'
  | 'unmatched'
  | 'feedbackDue'
  | 'closed';

export interface CardInput {
  eventBlocker: EventBlocker | null;
  memberBlocker: MemberBlocker | null;
  hasUsableProfile: boolean;
  entry: Pick<EventMatchEntry, 'status'> | null;
  hasIncomingPairInvite: boolean;
  /** Feedback prompt sent and the 7-day window still open. */
  isFeedbackOpen: boolean;
}

/** The single precedence order the gathering page card follows (spec 3.2). */
export function computeCardState(input: CardInput): {
  state: CardState;
  reason: MemberBlocker | null;
} {
  if (
    input.eventBlocker === 'notEnabled' ||
    input.eventBlocker === 'eventNotPublished'
  ) {
    return { state: 'unavailable', reason: null };
  }
  if (input.entry?.status === 'grouped') {
    return {
      state: input.isFeedbackOpen ? 'feedbackDue' : 'grouped',
      reason: null,
    };
  }
  if (input.memberBlocker) {
    return { state: 'ineligible', reason: input.memberBlocker };
  }
  if (input.entry?.status === 'waiting') {
    return { state: 'waiting', reason: null };
  }
  if (input.entry?.status === 'unmatched') {
    return { state: 'unmatched', reason: null };
  }
  if (input.eventBlocker === 'closed') return { state: 'closed', reason: null };
  if (input.hasIncomingPairInvite) return { state: 'pairInvite', reason: null };
  if (!input.hasUsableProfile) {
    return { state: 'questionnaireNeeded', reason: null };
  }
  return { state: 'notOptedIn', reason: null };
}
