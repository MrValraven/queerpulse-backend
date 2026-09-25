import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { ListingStatus } from './listing.entity';

/**
 * One moderation action taken on a `Listing` — the audit trail (item #16)
 * and reason-capture (item #15) backing `GET /admin/listings/:ref/history`,
 * and, through the narrower owner DTO, the owner-facing
 * `GET /listings/:ref/history`.
 * Written by `ListingsService` on every moderator-initiated action: a direct
 * status change (`setStatus`), a bulk status change (`bulkSetStatus`), a hard
 * removal (`removeByModerator`/`bulkRemove`), a question asked
 * (`askQuestion`), or a question answered (`answerQuestion`); by
 * `ListingsService.adminCreate` when staff author a listing for a business;
 * by `ListingOwnershipService.transferOwnership` on every ownership transfer
 * (reached from an approved claim in `ListingClaimsService.review` and from an
 * accepted staff offer in `ListingOwnerOffersService`); by
 * `ListingEditSuggestionsService.resolve` when an accepted edit suggestion is
 * written to the listing; by `ListingsService.update` when the owner or a
 * co-manager edits a live listing (`actorId` is the team member who made the
 * edit, which is the point: it records who changed an already-published
 * listing); by `ListingCoManagersService` when a co-manager
 * seat begins or ends; and by `ListingsService.setDirectoryVisibility` when
 * an owner or co-manager pauses or resumes the listing's directory visibility.
 *
 * The owner-facing history names the actor of a team action (`owner_edited`,
 * `co_manager_added`, `co_manager_removed`, `directory_paused`,
 * `directory_resumed`) only when that actor is the current owner or holds an
 * accepted co-manager seat that is still live or ended strictly after the
 * latest ownership transfer; any other actor reads as QueerPulse moderation. Team rows at or before the latest
 * `ownership_transferred` row read as a previous team member and lose their
 * reason text. Every other action reads as moderation.
 */
export enum ListingModerationAction {
  StatusChanged = 'status_changed',
  Removed = 'removed',
  QuestionAsked = 'question_asked',
  Answered = 'answered',
  BulkStatus = 'bulk_status',
  /**
   * The listing's `ownerId` moved from one member to another
   * (`ListingOwnershipService.transferOwnership`). Two paths reach it: a
   * moderator approving a `ListingClaim` (`ListingClaimsService.review`), and
   * a member accepting a staff owner offer (`ListingOwnerOffersService`, where
   * `actorId` is the accepting member). Before BE-HSG-05 an ownership transfer
   * was the one moderator action that left no trace at all: the previous
   * owner lost every `:ref` route on their listing with no notification and
   * nothing in this table to review afterwards.
   *
   * `fromStatus`/`toStatus` are both null on this action: a transfer changes
   * who owns the listing and leaves its moderation state alone. On the claim
   * path the `reason` carries the claimant's submitted note; both paths
   * append how many co-manager seats the transfer revoked. The newest row of
   * this action is also the line the owner-facing history draws between the
   * current team and a previous one. See migration
   * `AddListingOwnershipTransferredAction1793530200000`.
   */
  OwnershipTransferred = 'ownership_transferred',
  /**
   * The owner or a co-manager of a live listing edited it
   * (`ListingsService.update`). `actorId` is the team member who made the
   * edit, which is the point: it records who changed a listing that is
   * already published, the `reason` names in plain language what they
   * changed, and `changedFields` lists the `Listing` properties the edit
   * moved.
   *
   * An owner edit does not gate publication. Once a listing has been approved
   * it stays live through its owner's corrections, so this row is the audit
   * trail that replaced the forced re-review a moderated-field edit used to
   * trigger. When the edit restated the listing's identity (name, badge or
   * ownership link) and cost it its `queerOwnedVerified` badge, the `reason`
   * says so explicitly.
   *
   * `fromStatus`/`toStatus` are both null on this action: an owner edit changes
   * the listing's content and leaves its moderation state alone. See migration
   * `AddListingOwnerEditedAction1793960000000`.
   */
  OwnerEdited = 'owner_edited',
  /**
   * A member ACCEPTED an invitation to co-manage this listing
   * (`ListingCoManagersService.respondToInvite`). Written on the accept rather
   * than on the invite, because that is the moment access actually begins; an
   * invitation nobody answered changed nothing about who can edit the page, and
   * putting invite churn in this table would bury the events that matter.
   *
   * `actorId` is the member who accepted, so this joins `owner_edited` as an
   * action whose actor is not a moderator. The `reason` is composed by the
   * platform and names the member in plain language, so it is on
   * `OWNER_VISIBLE_MODERATION_REASON_ACTIONS`: an owner reviewing who has
   * access to their business page has to be able to read who it is. A row
   * at or before the latest ownership transfer is the exception: the owner
   * view shows it as a previous team member's action and withholds the
   * reason, so a new owner does not learn who ran the listing before them.
   *
   * `fromStatus`/`toStatus` are both null: a co-manager change moves no
   * moderation state. See migration
   * `AddListingCoManagerEnumValues1794530000000`.
   */
  CoManagerAdded = 'co_manager_added',
  /**
   * A co-manager seat that was ACTIVE ended: the owner revoked it
   * (`actorId` is the owner), the co-manager stepped down (`actorId` is the
   * co-manager), or staff took the seat back through
   * `ListingCoManagersService.staffRevokeCoManager` (`actorId` is the acting
   * admin). An admin is neither the owner nor a seat holder, so the owner
   * view shows that last case as QueerPulse moderation and names nobody. A
   * pending invitation that was withdrawn or declined writes nothing here, for
   * the same reason `co_manager_added` is not written on the invite: nothing
   * was ever granted.
   *
   * The mass revocation an ownership transfer performs is deliberately NOT
   * logged one row per seat. That transfer already writes exactly one
   * `ownership_transferred` row, and the count of seats it cleared is recorded
   * in that row's own `reason` — one event for one act, rather than a burst of
   * rows a reader has to reassemble.
   */
  CoManagerRemoved = 'co_manager_removed',
  /**
   * A listing staff authored on a business's behalf
   * (`ListingsService.adminCreate`, written best-effort by
   * `recordStaffCreated`). `actorId` is the authoring admin.
   */
  StaffCreated = 'staff_created',
  /**
   * A moderator ACCEPTED a `ListingEditSuggestion` and the suggested value was
   * written to the listing (`ListingEditSuggestionsService.resolve`). Only a
   * write counts: an accepted suggestion whose value failed validation, or
   * whose field has no column to write (`other`), leaves the listing as it was
   * and writes nothing here.
   *
   * `actorId` is the moderator who accepted. `changedFields` holds the one
   * column written (`address`, `hoursNote`, `tagline`, or `social` for a phone
   * number or website). The `reason` is composed by the platform and names the
   * field in plain language without the value itself, so it is on
   * `OWNER_VISIBLE_MODERATION_REASON_ACTIONS`.
   *
   * `fromStatus`/`toStatus` are both null: applying a correction changes the
   * listing's content and leaves its moderation state alone. See migration
   * `AddListingHistoryActionsAndChangedFields1821900000000`.
   */
  SuggestionApplied = 'suggestion_applied',
  /**
   * The owner or a co-manager hid the listing from the directory
   * (`ListingsService.setDirectoryVisibility`, `isHiddenByOwner` moving from
   * false to true). `actorId` is the member who paused it. Re-sending the
   * current visibility writes nothing.
   *
   * `fromStatus`/`toStatus`, `reason` and `changedFields` are all null: pausing
   * is an owner choice layered on top of the moderation state, which stays as
   * it was. See migration
   * `AddListingHistoryActionsAndChangedFields1821900000000`.
   */
  DirectoryPaused = 'directory_paused',
  /**
   * The owner or a co-manager brought a paused listing back to the directory
   * (`ListingsService.setDirectoryVisibility`, `isHiddenByOwner` moving from
   * true to false). `actorId` is the member who resumed it. Same null fields
   * as `directory_paused`.
   */
  DirectoryResumed = 'directory_resumed',
}

/**
 * Audit-trail row for one moderation action on a listing.
 *
 * `listingId` is a plain indexed uuid with deliberately NO foreign key to
 * `listings` — mirrors `ListingReview.listingId`'s precedent (this domain
 * never hard-FKs a child row back to the owning `Listing`, only to `users`;
 * see that entity's doc comment). That choice matters here specifically: a
 * moderator hard-deleting a listing (`removeByModerator`/`bulkRemove`) must
 * never cascade away the very `removed` event that documents the deletion.
 * The row becomes historically orphaned once its listing is gone, which is
 * expected — `GET /admin/listings/:ref/history` is `ref`-keyed and 404s once
 * the listing itself no longer exists, so the row simply stops being
 * reachable through that endpoint, exactly like a `reports.subjectId`
 * pointing at a since-removed subject.
 *
 * `actorId` carries whoever acted: the moderator/admin on staff actions, the
 * owner or co-manager on team actions (see each action's doc); nullable +
 * `ON DELETE SET
 * NULL` so an account erasure nulls the identity out while the audit row
 * survives (mirrors `ListingReview.reviewerId` / `AddUserRefForeignKeys`'s
 * convention for user references — unlike the listing reference above, this
 * IS a real FK, because "who did this" must stay referentially honest).
 *
 * `fromStatus`/`toStatus` are plain nullable varchars typed as `ListingStatus
 * | null` in TS rather than a shared Postgres enum with `listings.status` —
 * keeps this table's schema decoupled from that column's enum lifecycle
 * (same rationale `ContentModeration` documents for its own
 * `subjectType`/`subjectId`).
 */
@Entity('listing_moderation_events')
export class ListingModerationEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_listing_moderation_events_listing_id')
  @Column({ type: 'uuid' })
  listingId!: string;

  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  // FK to `users(id)` ON DELETE SET NULL — see the class doc comment.
  @Index('IDX_listing_moderation_events_actor_id')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actor_id' })
  actor!: User | null;

  @Column({
    type: 'enum',
    enum: ListingModerationAction,
    enumName: 'listing_moderation_events_action_enum',
  })
  action!: ListingModerationAction;

  @Column({ type: 'varchar', nullable: true })
  fromStatus!: ListingStatus | null;

  @Column({ type: 'varchar', nullable: true })
  toStatus!: ListingStatus | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  /**
   * The `Listing` property names this action touched, so a reader can name
   * the changed fields in their own language. Written for `owner_edited` (every
   * column the edit changed) and `suggestion_applied` (the one column
   * written). Null on every other action and on rows written before migration
   * `AddListingHistoryActionsAndChangedFields1821900000000`.
   */
  @Column({ type: 'text', array: true, nullable: true })
  changedFields!: string[] | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
