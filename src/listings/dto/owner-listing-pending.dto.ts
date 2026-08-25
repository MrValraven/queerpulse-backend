import { Report } from '../../reports/entities/report.entity';
import { ListingClaim } from '../entities/listing-claim.entity';
import { ListingEditSuggestion } from '../entities/listing-edit-suggestion.entity';
import { ListingQuestion } from '../entities/listing-question.entity';

/**
 * How many items of each kind are still awaiting a decision on the listing,
 * regardless of how many of them the item arrays below actually carry (those
 * are capped; see `OWNER_PENDING_ITEM_CAP`). This is what a nav badge reads,
 * so the frontend never has to fetch the items to count them.
 */
export interface OwnerListingPendingCountsDTO {
  editSuggestions: number;
  ownershipClaims: number;
  disputes: number;
  unansweredQuestions: number;
  /** The four above added together: the single number a badge renders. */
  total: number;
}

/**
 * One pending member-suggested correction, as the OWNER sees it.
 *
 * The whole point of C8: most suggestions are true, and the owner is the
 * fastest person alive to confirm one, so they get the full
 * content: which field is being corrected, the prose, and the typed replacement value
 * when the suggester supplied one.
 *
 * What they do NOT get is who filed it. The admin queue row
 * (`EditSuggestionQueueDTO`) carries a `suggestedBy` `MemberRef`; this
 * interface omits the key entirely rather than sending `null`, so no later
 * mapper edit can start populating it by accident. A queer venue's owner
 * learning exactly which member reported them is a safety problem even when
 * the report is a friendly correction.
 */
export interface OwnerPendingEditSuggestionDTO {
  id: string;
  /** One of `EDIT_SUGGESTION_FIELDS`, stored as a plain string. */
  field: string;
  message: string;
  /** `null` when the member described the problem without proposing a fix. */
  proposedValue: string | null;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/**
 * One pending claim on the listing's ownership, as the OWNER sees it.
 *
 * Carries an id and a timestamp and NOTHING else. A claim is an adversarial
 * act by definition: somebody is asking a moderator to take this listing off
 * the person reading this response. Two things are therefore withheld:
 *
 *  - `claimant`, obviously, which the admin `ListingClaimDTO` carries.
 *  - `note`, which the admin DTO also carries. It is the claimant's free-text
 *    "I'm the owner, here's how to verify me" written for a moderator, and its
 *    entire purpose is self-identification, so forwarding it is a slower way
 *    of forwarding the identity. `ListingClaimsService.notifyDisplacedOwnerBestEffort`
 *    already refuses to name the claimant when telling an owner they LOST the
 *    listing; telling them a claim is merely pending must not disclose more
 *    than that does.
 *
 * The owner cannot act on a claim anyway. A moderator decides it. What they
 * need is to know it exists so they can get ahead of it.
 */
export interface OwnerPendingOwnershipClaimDTO {
  id: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/**
 * One open dispute against the listing, as the OWNER sees it. Same shape and
 * same reasoning as `OwnerPendingOwnershipClaimDTO`: the reporter's identity
 * is withheld, and so is the dispute's free-text `detail`, which is a member
 * explaining to a moderator why this listing misrepresents a business and
 * routinely says who they are in the process.
 */
export interface OwnerPendingDisputeDTO {
  id: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/**
 * One moderator question the owner has not answered yet.
 *
 * The body IS shown: a moderator wrote it to this owner and
 * `ListingsService.askQuestion` already delivers the same text to them as a
 * DM. The asker is not shown, matching the owner history endpoint. This is the
 * one pending item the owner can clear themself, via
 * `POST /listings/:ref/questions/:id/answer`, which is why the `id` is worth
 * carrying.
 */
export interface OwnerPendingListingQuestionDTO {
  id: string;
  body: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/**
 * `GET /listings/:ref/pending` response (C8). Everything currently awaiting a
 * decision on a listing the caller owns.
 *
 * Four queues feed it, and all four are scoped by LISTING, never by the member
 * who filed the item.
 */
export interface OwnerListingPendingDTO {
  counts: OwnerListingPendingCountsDTO;
  /** Newest first, capped at `OWNER_PENDING_ITEM_CAP`. */
  editSuggestions: OwnerPendingEditSuggestionDTO[];
  /** Newest first, capped at `OWNER_PENDING_ITEM_CAP`. */
  ownershipClaims: OwnerPendingOwnershipClaimDTO[];
  /** Newest first, capped at `OWNER_PENDING_ITEM_CAP`. */
  disputes: OwnerPendingDisputeDTO[];
  /** Newest first, capped at `OWNER_PENDING_ITEM_CAP`. */
  unansweredQuestions: OwnerPendingListingQuestionDTO[];
}

export function toOwnerPendingEditSuggestionDTO(
  suggestion: ListingEditSuggestion,
): OwnerPendingEditSuggestionDTO {
  return {
    id: suggestion.id,
    field: suggestion.field,
    message: suggestion.message,
    proposedValue: suggestion.proposedValue,
    createdAt: suggestion.createdAt.toISOString(),
  };
}

export function toOwnerPendingOwnershipClaimDTO(
  claim: ListingClaim,
): OwnerPendingOwnershipClaimDTO {
  return { id: claim.id, createdAt: claim.createdAt.toISOString() };
}

export function toOwnerPendingDisputeDTO(
  report: Report,
): OwnerPendingDisputeDTO {
  return { id: report.id, createdAt: report.createdAt.toISOString() };
}

export function toOwnerPendingListingQuestionDTO(
  question: ListingQuestion,
): OwnerPendingListingQuestionDTO {
  return {
    id: question.id,
    body: question.body,
    createdAt: question.createdAt.toISOString(),
  };
}
