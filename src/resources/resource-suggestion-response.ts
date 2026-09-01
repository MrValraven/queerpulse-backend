import { MemberRef } from '../common/member-ref';
import {
  ResourceSuggestion,
  ResourceSuggestionStatus,
} from './entities/resource-suggestion.entity';

/** Shape returned by `POST /resources/suggestions` — just enough for the
 *  frontend's success state to confirm what was sent. */
export interface ResourceSuggestionResponseDTO {
  id: string;
  category: string;
  name: string;
  description: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  createdAt: string;
}

export function toResourceSuggestionResponse(
  suggestion: ResourceSuggestion,
): ResourceSuggestionResponseDTO {
  return {
    id: suggestion.id,
    category: suggestion.category,
    name: suggestion.name,
    description: suggestion.description,
    phone: suggestion.phone,
    email: suggestion.email,
    website: suggestion.website,
    createdAt: suggestion.createdAt.toISOString(),
  };
}

export interface AdminPersonDTO {
  slug: string;
  name: string;
  avatarUrl: string | null;
}

export function toAdminPerson(ref: MemberRef | null): AdminPersonDTO | null {
  if (!ref) return null;
  return {
    slug: ref.slug,
    name: `${ref.firstName} ${ref.lastName}`.trim(),
    avatarUrl: ref.avatarUrl,
  };
}

/** One resource-suggestion row on the admin review queue. `decidedBy` is
 *  deliberately NOT exposed — mirrors `AdminReadingGroupProposalDTO`. */
export interface AdminResourceSuggestionDTO {
  id: string;
  member: AdminPersonDTO | null;
  category: string;
  name: string;
  description: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  createdAt: string;
  status: ResourceSuggestionStatus;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface AdminResourceSuggestionsPageDTO {
  items: AdminResourceSuggestionDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export function toAdminResourceSuggestionDTO(
  suggestion: ResourceSuggestion,
  member: MemberRef | null,
): AdminResourceSuggestionDTO {
  return {
    id: suggestion.id,
    member: toAdminPerson(member),
    category: suggestion.category,
    name: suggestion.name,
    description: suggestion.description,
    phone: suggestion.phone,
    email: suggestion.email,
    website: suggestion.website,
    createdAt: suggestion.createdAt.toISOString(),
    status: suggestion.status,
    decidedAt: suggestion.decidedAt ? suggestion.decidedAt.toISOString() : null,
    decisionNote: suggestion.decisionNote,
  };
}

/**
 * The submitter's own view of a resource they suggested (PRD-45).
 *
 * Before this shape existed a member who suggested a resource was never told
 * anything: the admin queue recorded their id and the reviewer's note, and
 * none of it ever came back. This is the pull half of the answer, the bell
 * row written by `SubmissionDecisionNotifier` is the push half.
 *
 * Hand-mapped from the entity because this codebase has no global serializer,
 * so a column added to `resource_suggestion` never reaches a member by
 * accident. Two columns are deliberately withheld:
 *
 *  - `memberId`: it is always the caller's own id here, so echoing it back
 *    tells them nothing and puts a user id on the wire for no reason.
 *  - `decidedBy`: which member of staff decided is an internal fact. The
 *    admin queue's own DTO withholds it for the same reason, and so does
 *    `SafeSpaceNominationResponse`.
 */
export interface MyResourceSuggestionDTO {
  id: string;
  category: string;
  name: string;
  description: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  /** When the member sent it in. */
  createdAt: string;
  status: ResourceSuggestionStatus;
  /** When the current `status` was decided, null while still pending. */
  decidedAt: string | null;
  /**
   * The reviewer's written reason, addressed to this member.
   *
   * This is the same `decision_note` column the admin queue writes, and the
   * column has exactly one audience: the person who submitted. There is no
   * separate internal-notes field on `resource_suggestion`, the sibling
   * intake this module was copied from spends the column on the reason it
   * tells the proposer (`AdminReadingGroupProposalsService.decline`), and the
   * two nearest precedents for a member's own intake view both carry the
   * reviewer's prose through to the member: `StorySubmissionResponse.decisionNote`
   * ("the only prose the member gets about it, since QueerPulse delivers no
   * email") and `SafeSpaceNominationResponse.decisionReason`.
   *
   * So it is shown. A declined suggestion whose reason is withheld is a
   * refusal with no reason at all, and QueerPulse has no second channel to
   * put the reason on. `DecideResourceSuggestionDto` says the same thing to
   * the staff member typing it.
   */
  decisionNote: string | null;
}

/** `GET /resources/suggestions/mine`. Always an object, never null, so the
 *  client never has to distinguish "no suggestions" from "no answer". */
export interface MyResourceSuggestionsDTO {
  items: MyResourceSuggestionDTO[];
}

export function toMyResourceSuggestionDTO(
  suggestion: ResourceSuggestion,
): MyResourceSuggestionDTO {
  return {
    id: suggestion.id,
    category: suggestion.category,
    name: suggestion.name,
    description: suggestion.description,
    phone: suggestion.phone,
    email: suggestion.email,
    website: suggestion.website,
    createdAt: suggestion.createdAt.toISOString(),
    status: suggestion.status,
    decidedAt: suggestion.decidedAt ? suggestion.decidedAt.toISOString() : null,
    decisionNote: suggestion.decisionNote,
  };
}
