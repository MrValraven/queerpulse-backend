import type { MeetAgainVerdict } from './entities/match-feedback.entity';
import type { GroupClickAnswer } from './entities/match-group-feedback.entity';
import type { GroupBand, GroupReason } from './go-together-reasons';

/** First name and pronouns only (spec 3.4); the avatar follows the member's
 *  own `photoVisible`. The member's handle stays off the card: it is built
 *  from the full name. `memberRef` is an opaque id that only the group's own
 *  member routes accept (`POST /go-together/groups/:groupId/members/
 *  :memberRef/block` and `/report`, PRD-421); it opens no profile. */
export interface GoTogetherGroupMember {
  memberRef: string;
  firstName: string;
  pronouns: string | null;
  avatarUrl: string | null;
  isYou: boolean;
  isPairPartner: boolean;
  isHere: boolean;
  hasLeftEvent: boolean;
}

export interface GoTogetherGroupResponse {
  id: string;
  event: {
    id: string;
    slug: string;
    title: string;
    startAt: string;
    endAt: string | null;
  };
  band: GroupBand;
  reasons: GroupReason[];
  meetingPointNote: string | null;
  conversationId: string | null;
  isDissolved: boolean;
  /** PRD-418: true from the gathering's start onward, when Leave ends only
   *  the caller's chat seat and keeps them in the group (the meet-again page
   *  and their own reveal stay). False before the start, when Leave takes
   *  them out of Go together for this gathering. */
  isLeaveChatOnly: boolean;
  /** True once the caller holds no seat in the group's chat (they left it
   *  after the start, or were never seated). False when the group has no
   *  chat at all (`conversationId: null`). The FE hides Open chat and
   *  Leave chat when it is true. */
  hasLeftChat: boolean;
  members: GoTogetherGroupMember[];
  mergeOffer: { groupId: string } | null;
  checkIn: { isOpen: boolean; isHere: boolean; hasLeftEvent: boolean };
  feedback: { isOpen: boolean; closesAt: string | null; hasAnswered: boolean };
}

export interface GoTogetherFeedbackMember {
  slug: string;
  firstName: string;
  pronouns: string | null;
  avatarUrl: string | null;
  verdict: MeetAgainVerdict | null;
}

export interface GoTogetherFeedbackResponse {
  groupId: string;
  isOpen: boolean;
  closesAt: string | null;
  members: GoTogetherFeedbackMember[];
  clicked: GroupClickAnswer | null;
  goAgain: boolean;
}
