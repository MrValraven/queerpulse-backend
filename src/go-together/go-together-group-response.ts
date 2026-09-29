import type { MeetAgainVerdict } from './entities/match-feedback.entity';
import type { GroupClickAnswer } from './entities/match-group-feedback.entity';
import type { GroupBand, GroupReason } from './go-together-reasons';

/** First name and pronouns only (spec 3.4); the avatar follows the member's
 *  own `photoVisible`. */
export interface GoTogetherGroupMember {
  slug: string;
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
