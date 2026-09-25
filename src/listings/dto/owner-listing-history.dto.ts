import { MemberRef } from '../../common/member-ref';
import {
  ListingModerationAction,
  ListingModerationEvent,
} from '../entities/listing-moderation-event.entity';
import { ListingQuestion } from '../entities/listing-question.entity';
import { ListingStatus } from '../entities/listing.entity';

/**
 * Who an owner is told acted on a history row. A discriminated union so the
 * three cases are exhaustive in the type, and so a staff row structurally has
 * no place to carry a person:
 *
 *  - `team`: the listing's current team acted, and `member` names them. The
 *    team is the current owner plus every member whose ACCEPTED co-manager
 *    seat on the listing is still live or ended after the latest ownership
 *    transfer (any accepted seat, when there was no transfer). `member` is
 *    `null` when the account was erased (`actorId` is `ON DELETE SET NULL`)
 *    or has no profile to show.
 *  - `previous_team`: a team action from before the latest ownership
 *    transfer. Who it was stays unsaid, and so does the row's `reason`.
 *  - `moderation`: the platform or its staff acted. That includes a team
 *    action whose actor is outside the team, such as an admin revoking a seat
 *    through `ListingCoManagersService.staffRevokeCoManager`, which writes a
 *    `co_manager_removed` row with the admin as `actorId`. Staff identity is
 *    internal.
 *
 * Decided in one place, `resolveOwnerHistoryActor`.
 */
export type OwnerHistoryActorDTO =
  | { kind: 'team'; member: MemberRef | null }
  | { kind: 'previous_team' }
  | { kind: 'moderation' };

/**
 * The OWNER-facing twin of `ListingModerationEventDTO` (C3), returned by
 * `GET /listings/:ref/history`. Deliberately a separate interface rather than
 * a reuse of the admin one, because the two differ in exactly the places that
 * matter for safety, and a shared shape would have made "the owner sees a
 * narrower row" a runtime convention instead of a type.
 *
 * The differences, all of them deliberate:
 *
 *  - `actor` is an `OwnerHistoryActorDTO`, which names a person only for a
 *    team action taken after the latest ownership transfer by someone on the
 *    listing's team. The admin row carries a `MemberRef` for whoever acted;
 *    this one reduces a staff action to `moderation`, because the platform's
 *    other moderation surfaces already treat staff identity as internal. A
 *    team action from before the latest transfer becomes `previous_team`: a
 *    claimant who wins a listing inherits its history, and learning who ran
 *    the business before them would hand them the displaced owner's identity,
 *    the same disclosure `notifyDisplacedOwnerBestEffort` refuses to make in
 *    the other direction.
 *  - `reason` is shown only when the platform composed the text (see
 *    `OWNER_VISIBLE_MODERATION_REASON_ACTIONS`), and it is dropped on a
 *    `previous_team` row too, because the co-manager reasons spell out a
 *    member's name and would undo the anonymised actor beside them.
 *  - `hasModeratorNote` replaces the withheld text with the one bit an owner
 *    can act on: a moderator wrote something about this event, and the
 *    wording reached the owner through the send-back/removal DM the
 *    moderation flow already sends. See `isModeratorNoteSentToOwner`.
 *  - `changedFields` is the one field the owner row carries and the admin
 *    row does not: the `Listing` properties an owner edit or an applied
 *    suggestion changed, so the owner's timeline can say what moved.
 *
 * The shared fields (`id`, `action`, `fromStatus`, `toStatus`, `createdAt`)
 * match the admin row field for field, so a frontend can render both
 * timelines from one component.
 */
export interface OwnerListingModerationEventDTO {
  id: string;
  action: ListingModerationAction;
  fromStatus: ListingStatus | null;
  toStatus: ListingStatus | null;
  /**
   * The event's reason text, or `null` when the owner may not see it.
   * Non-null only for an action listed in
   * `OWNER_VISIBLE_MODERATION_REASON_ACTIONS` on a row whose actor is not
   * `previous_team`.
   */
  reason: string | null;
  /**
   * `true` when a moderator wrote a note on this event AND that note was
   * DM'd to the listing's owner (`isModeratorNoteSentToOwner`). Lets the
   * frontend say "a moderator left a note about this" and point at the
   * member's messages, without putting the note itself on screen. `false` on
   * every row whose reason stayed internal or was composed by the platform.
   */
  hasModeratorNote: boolean;
  /** Who acted, as far as the owner may know. See `OwnerHistoryActorDTO`. */
  actor: OwnerHistoryActorDTO;
  /**
   * The `Listing` property names this event changed, on `owner_edited` and
   * `suggestion_applied` rows. `null` on every other action and on rows
   * written before the column existed.
   */
  changedFields: string[] | null;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/**
 * The actions a listing's own team takes: the owner or a co-manager editing
 * the page, changing who co-manages it, or pausing and resuming it in the
 * directory. Only these rows can name a person to the owner, and only when
 * the actor belongs to the listing's team (`resolveOwnerHistoryActor`), since
 * staff can write one of these actions too.
 *
 * An allowlist, on purpose: a new `ListingModerationAction` added later reads
 * as `moderation` until someone decides its actor is a team member and adds
 * it here.
 */
export const LISTING_TEAM_ACTIONS: readonly ListingModerationAction[] = [
  ListingModerationAction.OwnerEdited,
  ListingModerationAction.CoManagerAdded,
  ListingModerationAction.CoManagerRemoved,
  ListingModerationAction.DirectoryPaused,
  ListingModerationAction.DirectoryResumed,
];

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
 * `staff_created` qualifies for the same reason: `recordStaffCreated` writes
 * one of two fixed platform sentences (published straight away, or sent to
 * the moderation queue) and nothing a person typed.
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
    //
    // On a `previous_team` row `toOwnerListingModerationEventDTO` drops these
    // reasons again, so a member who won the listing by transfer reads no
    // names from the team that ran it before them.
    ListingModerationAction.CoManagerAdded,
    ListingModerationAction.CoManagerRemoved,
    // Composed by the platform when a moderator applies a member's edit
    // suggestion: a fixed sentence naming the field's LABEL. It never quotes
    // the suggested value or the suggester, so it tells the owner which part
    // of their page changed and nothing about who proposed it.
    ListingModerationAction.SuggestionApplied,
    // One of two fixed sentences from `ListingsService.recordStaffCreated`.
    ListingModerationAction.StaffCreated,
  ];

/**
 * Whether this event's moderator note was actually DM'd to the listing's
 * owner, which is the only case `hasModeratorNote` may be `true`: the owner
 * UI tells them the note is in their messages.
 *
 * Mirrors the DM paths in `ListingsService` exactly:
 *
 *  - `status_changed` (`setStatus`) and `bulk_status` (`bulkSetStatus`) DM
 *    the owner `statusChangeMessage`, reason included, on every transition
 *    to a status other than `live`. A transition into `live` sends the
 *    `ListingApproved` notification instead, which carries no note.
 *  - `removed` (`removeByModerator` / `bulkRemove`) DMs the owner the
 *    removal, reason included.
 *
 * Every other action's reason stays internal or was composed by the
 * platform, so it never reached the owner as a moderator's note.
 */
export function isModeratorNoteSentToOwner(
  event: Pick<ListingModerationEvent, 'action' | 'toStatus' | 'reason'>,
): boolean {
  if (event.reason === null) return false;
  if (event.action === ListingModerationAction.Removed) return true;
  const isStatusAction =
    event.action === ListingModerationAction.StatusChanged ||
    event.action === ListingModerationAction.BulkStatus;
  return isStatusAction && event.toStatus !== ListingStatus.Live;
}

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
 *
 * `questions` holds only the questions asked strictly after the latest
 * ownership transfer (all of them when there was none). An answer is free
 * text the owner of the day typed, and it routinely names them, so the
 * previous owner's thread stays with the previous team.
 */
export interface OwnerListingHistoryDTO {
  events: OwnerListingModerationEventDTO[];
  questions: OwnerListingQuestionDTO[];
  /** Total moderation events on the listing, across every page. */
  totalEvents: number;
  page: number;
  pageSize: number;
}

/**
 * THE one place the owner-facing actor is decided. Pure, so the whole rule is
 * testable without a Nest module:
 *
 *  - an action outside `LISTING_TEAM_ACTIONS` is `moderation`;
 *  - a team action at or before `latestTransferAt` (the newest
 *    `ownership_transferred` row) is `previous_team`, so a new owner never
 *    learns who ran the listing before them;
 *  - a team action by an erased actor (`actorId` null) is `team` with
 *    `member: null`. It runs before the team-membership check, so an erased
 *    admin's seat revocation also reads as an unnamed team member: once
 *    `actorId` is null the two rows are identical, and an unnamed member
 *    discloses no one. Accepted on purpose; any future change here must stay
 *    free of identity lookups for a null actor;
 *  - a team action whose actor is outside `teamMemberIds` is `moderation`.
 *    Staff write `co_manager_removed` when an admin revokes a seat, and the
 *    admin must stay unnamed;
 *  - every other team action is `team`, named from `membersByUserId`, or with
 *    `member: null` when the actor has no profile.
 *
 * `teamMemberIds` is the listing's current owner plus every member whose
 * accepted co-manager seat is still live or ended after the latest transfer
 * (the caller builds it). `membersByUserId` only needs the actors of `team`
 * rows; the caller resolves no other ids.
 */
export function resolveOwnerHistoryActor(
  event: Pick<ListingModerationEvent, 'action' | 'actorId' | 'createdAt'>,
  latestTransferAt: Date | null,
  teamMemberIds: ReadonlySet<string>,
  membersByUserId: Map<string, MemberRef>,
): OwnerHistoryActorDTO {
  if (!LISTING_TEAM_ACTIONS.includes(event.action)) {
    return { kind: 'moderation' };
  }
  if (
    latestTransferAt !== null &&
    event.createdAt.getTime() <= latestTransferAt.getTime()
  ) {
    return { kind: 'previous_team' };
  }
  if (event.actorId === null) {
    return { kind: 'team', member: null };
  }
  if (!teamMemberIds.has(event.actorId)) {
    return { kind: 'moderation' };
  }
  return {
    kind: 'team',
    member: membersByUserId.get(event.actorId) ?? null,
  };
}

export function toOwnerListingModerationEventDTO(
  event: ListingModerationEvent,
  actor: OwnerHistoryActorDTO,
): OwnerListingModerationEventDTO {
  // A `previous_team` row loses its reason as well: the co-manager reasons
  // name a member, which would undo the anonymised actor. Nothing a moderator
  // wrote is hidden by this, so it raises no moderator-note flag either.
  const isPreviousTeam = actor.kind === 'previous_team';
  const isReasonOwnerVisible = OWNER_VISIBLE_MODERATION_REASON_ACTIONS.includes(
    event.action,
  );
  return {
    id: event.id,
    action: event.action,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    reason: isReasonOwnerVisible && !isPreviousTeam ? event.reason : null,
    hasModeratorNote: !isPreviousTeam && isModeratorNoteSentToOwner(event),
    actor,
    changedFields: event.changedFields ?? null,
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
