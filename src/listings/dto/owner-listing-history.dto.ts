import {
  ListingModerationAction,
  ListingModerationEvent,
} from '../entities/listing-moderation-event.entity';
import { ListingQuestion } from '../entities/listing-question.entity';
import { ListingStatus } from '../entities/listing.entity';

/**
 * The OWNER-facing twin of `ListingModerationEventDTO` (C3), returned by
 * `GET /listings/:ref/history`. Deliberately a separate interface rather than
 * a reuse of the admin one, because the two differ in exactly the places that
 * matter for safety, and a shared shape would have made "the owner sees a
 * narrower row" a runtime convention instead of a type.
 *
 * The differences, all of them deliberate:
 *
 *  - There is NO `actor` field at all. The admin row carries a `MemberRef` for
 *    the moderator who acted; this one omits the key rather than always
 *    sending `null`, so no future mapper edit can accidentally start
 *    populating it. The platform's other moderation surfaces already treat
 *    staff identity as internal, and this endpoint follows that.
 *  - `reason` is withheld unless the text was written BY the platform rather
 *    than typed by a person. See `OWNER_VISIBLE_MODERATION_REASON_ACTIONS`.
 *  - `hasModeratorNote` replaces the withheld text with the one bit an owner
 *    can act on: a human wrote something about this event, and the wording
 *    reached them through the send-back/removal DM the moderation flow already
 *    sends.
 *
 * Everything else (`id`, `action`, `fromStatus`, `toStatus`, `createdAt`)
 * matches the admin row field for field, so a frontend can render both
 * timelines from one component.
 */
export interface OwnerListingModerationEventDTO {
  id: string;
  action: ListingModerationAction;
  fromStatus: ListingStatus | null;
  toStatus: ListingStatus | null;
  /**
   * The event's reason text, or `null` when the owner may not see it. Only
   * ever non-null for an action listed in
   * `OWNER_VISIBLE_MODERATION_REASON_ACTIONS`.
   */
  reason: string | null;
  /**
   * `true` when this event carries a reason the owner is not shown. Lets the
   * frontend say "a moderator left a note about this" and point at the
   * member's messages, without putting the note itself on screen.
   */
  hasModeratorNote: boolean;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/**
 * The ONLY actions whose `reason` string an owner is allowed to read.
 *
 * An allowlist rather than a denylist, on purpose: a new
 * `ListingModerationAction` added later is hidden by default and has to be
 * opted in by someone who has looked at what its reason text actually
 * contains. The reverse (a denylist) would leak a new action's reason the day
 * it ships.
 *
 * `owner_edited` qualifies because its reason is composed by
 * `ListingsService.update` out of `OWNER_EDITABLE_FIELD_LABELS`: plain
 * language naming the fields the owner themself just changed. There is no
 * human-typed text in it, and it is a description of the owner's own action.
 *
 * Every other action's reason is free text somebody typed for a moderator's
 * eyes, and two of them are actively unsafe to forward:
 *
 *  - `status_changed` / `bulk_status` / `removed` carry the moderator's
 *    internal note. The owner is not left in the dark by withholding it:
 *    `ListingsService.statusChangeMessage` and `removeByModerator` already DM
 *    the owner the moderator's wording on a send-back or a removal, which is
 *    the channel written for them. What is withheld here is the same string in
 *    a context the moderator never chose to publish, and moderators write
 *    internal notes on approvals too, where nothing is DM'd at all.
 *  - `ownership_transferred` carries the CLAIMANT's own submitted note
 *    verbatim (`ListingClaimsService.review` interpolates it). That note is a
 *    stranger explaining to a moderator why the listing should be taken off
 *    its current owner, and it routinely self-identifies its author. Handing
 *    it to the person being contested is the exact disclosure
 *    `notifyDisplacedOwnerBestEffort` already refuses to make.
 *  - `question_asked` / `answered` carry no reason worth surfacing; the
 *    question and answer text lives on the Q&A thread below, which the owner
 *    does see.
 */
export const OWNER_VISIBLE_MODERATION_REASON_ACTIONS: readonly ListingModerationAction[] =
  [
    ListingModerationAction.OwnerEdited,
    // Both co-manager reasons are composed by `ListingCoManagersService` out of
    // a member's display name and a fixed sentence. There is no human-typed
    // text in either, and the whole value of the row to an owner is being able
    // to read WHO gained or lost access to their business page; withheld, the
    // event would say only that the roster changed at some point.
    //
    // A co-manager reads this endpoint too, and so reads these names. That is
    // intended and it is the same information `GET /listings/:ref/co-managers`
    // already gives them: who else can edit the page is operational fact for
    // anyone who can edit the page. It is not the owner's personal data (see
    // `listing-owner-personal-fields.ts` for what is), and it is not public.
    ListingModerationAction.CoManagerAdded,
    ListingModerationAction.CoManagerRemoved,
  ];

/**
 * The owner-facing twin of `ListingQuestionDTO`. Same fields minus `askedBy`:
 * the question body is safe to show (a moderator wrote it TO this owner, and
 * `askQuestion` already DMs them the same text), while which moderator asked
 * it is internal.
 */
export interface OwnerListingQuestionDTO {
  id: string;
  body: string;
  answer: string | null;
  /** ISO 8601 timestamp, or `null` while unanswered. */
  answeredAt: string | null;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/**
 * `GET /listings/:ref/history` response (C3). The owner's own view of what
 * has happened to their listing.
 *
 * Mirrors the admin `ListingHistoryDTO`'s `{ events, questions }` envelope so
 * the two agree, widened with the page envelope the admin one does not need.
 * `events` is the collection that grows without bound (every owner edit writes
 * a row), so it is page-paginated newest-first with `PAGE_SIZE`. `questions`
 * is a short thread on a single listing, so it is returned whole under a cap
 * rather than paginated on its own axis, matching how the admin endpoint
 * returns it.
 */
export interface OwnerListingHistoryDTO {
  events: OwnerListingModerationEventDTO[];
  questions: OwnerListingQuestionDTO[];
  /** Total moderation events on the listing, across every page. */
  totalEvents: number;
  page: number;
  pageSize: number;
}

export function toOwnerListingModerationEventDTO(
  event: ListingModerationEvent,
): OwnerListingModerationEventDTO {
  const isReasonOwnerVisible = OWNER_VISIBLE_MODERATION_REASON_ACTIONS.includes(
    event.action,
  );
  return {
    id: event.id,
    action: event.action,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    reason: isReasonOwnerVisible ? event.reason : null,
    hasModeratorNote: !isReasonOwnerVisible && event.reason !== null,
    createdAt: event.createdAt.toISOString(),
  };
}

export function toOwnerListingQuestionDTO(
  question: ListingQuestion,
): OwnerListingQuestionDTO {
  return {
    id: question.id,
    body: question.body,
    answer: question.answer,
    answeredAt: question.answeredAt ? question.answeredAt.toISOString() : null,
    createdAt: question.createdAt.toISOString(),
  };
}

export function toOwnerListingHistoryDTO(
  events: OwnerListingModerationEventDTO[],
  questions: OwnerListingQuestionDTO[],
  totalEvents: number,
  page: number,
  pageSize: number,
): OwnerListingHistoryDTO {
  return { events, questions, totalEvents, page, pageSize };
}
