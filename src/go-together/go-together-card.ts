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
  /** The final late-group pass has run (`lateGroupAt` is set), so no more
   *  matching follows for this gathering, even if it moves later. */
  isFinalPassDone: boolean;
}

/**
 * The single precedence order the gathering page card follows (spec 3.2).
 * A grouped member keeps the group card whatever the host's switch says:
 * the settings lock once matching runs, so a group always outlives a later
 * `notEnabled`. An unmatched member reads `closed` once the final late-group
 * pass has run, because no more matching follows it.
 */
export function computeCardState(input: CardInput): {
  state: CardState;
  reason: MemberBlocker | null;
} {
  if (input.eventBlocker === 'eventNotPublished') {
    return { state: 'unavailable', reason: null };
  }
  if (input.entry?.status === 'grouped') {
    return {
      state: input.isFeedbackOpen ? 'feedbackDue' : 'grouped',
      reason: null,
    };
  }
  if (input.eventBlocker === 'notEnabled') {
    return { state: 'unavailable', reason: null };
  }
  if (input.memberBlocker) {
    return { state: 'ineligible', reason: input.memberBlocker };
  }
  if (input.entry?.status === 'waiting') {
    return { state: 'waiting', reason: null };
  }
  if (input.entry?.status === 'unmatched') {
    return {
      state: input.isFinalPassDone ? 'closed' : 'unmatched',
      reason: null,
    };
  }
  if (input.eventBlocker === 'closed') return { state: 'closed', reason: null };
  if (input.hasIncomingPairInvite) return { state: 'pairInvite', reason: null };
  if (!input.hasUsableProfile) {
    return { state: 'questionnaireNeeded', reason: null };
  }
  return { state: 'notOptedIn', reason: null };
}
