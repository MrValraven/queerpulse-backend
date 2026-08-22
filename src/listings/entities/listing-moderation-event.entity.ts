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
 * and reason-capture (item #15) backing `GET /admin/listings/:ref/history`.
 * Written by `ListingsService` on every moderator-initiated action: a direct
 * status change (`setStatus`), a bulk status change (`bulkSetStatus`), a hard
 * removal (`removeByModerator`/`bulkRemove`), a question asked
 * (`askQuestion`), or a question answered (`answerQuestion`); by
 * `ListingClaimsService.review` on an approved ownership transfer; and by
 * `ListingsService.update` when an OWNER edit to a live listing re-opens its
 * review (the one row here whose `actorId` is the owner rather than a
 * moderator, which is the point: it records who caused the re-review).
 */
export enum ListingModerationAction {
  StatusChanged = 'status_changed',
  Removed = 'removed',
  QuestionAsked = 'question_asked',
  Answered = 'answered',
  BulkStatus = 'bulk_status',
  /**
   * A moderator approved a `ListingClaim` and the listing's `ownerId` moved
   * from one member to another (`ListingClaimsService.review`). Before
   * BE-HSG-05 an ownership transfer was the one moderator action that left no
   * trace at all: the previous owner lost every `:ref` route on their listing
   * with no notification and nothing in this table to review afterwards.
   *
   * `fromStatus`/`toStatus` are both null on this action — a transfer changes
   * who owns the listing, never its moderation state. The `reason` carries the
   * claimant's submitted note. See migration
   * `AddListingOwnershipTransferredAction1793530200000`.
   */
  OwnershipTransferred = 'ownership_transferred',
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
 * `actorId` carries the moderator/admin who acted; nullable + `ON DELETE SET
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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
