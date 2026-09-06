import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ResourceListingCategory } from './resource-listing.entity';

/**
 * Admin decision lifecycle for a member-submitted resource suggestion.
 * `pending` is the state every new suggestion is created in; an
 * admin/moderator then approves, declines, or archives it from the review
 * queue, stamping `decidedAt`/`decidedBy`.
 *
 * Approving DOES create the `ResourceListing` (PRD-269), in the same
 * transaction as the status flip, and records it on `createdListingId`. The
 * human verification crisis-adjacent content needs — legal aid, health
 * testing, where a wrong phone number or a defunct clinic has real cost — did
 * not go away: it moved INTO the approval, which now requires the reviewing
 * admin to confirm or correct every field of the listing body before the
 * status flips, instead of publishing the member's unverified words. What
 * went away is the silent second step, where the member was told "accepted"
 * and nothing reached the directory until somebody remembered to retype the
 * organisation by hand in a different console.
 *
 * `approved` is therefore TERMINAL in a way the other two are not: a second
 * approve on an already-approved row is refused rather than restamped, since
 * it would mean a second listing for the same organisation.
 */
export enum ResourceSuggestionStatus {
  Pending = 'pending',
  Approved = 'approved',
  Declined = 'declined',
  Archived = 'archived',
}

/**
 * A member's public submission proposing a new Legal Aid / Sexual Health
 * Testing resource — the "suggest a resource" pathway from the resource
 * pages' empty states. Kept entirely separate from `ResourceListing`, the
 * curated content it might eventually feed: this is member-authored and
 * unverified, that is staff-authored and vetted. Mirrors
 * `ReadingGroupProposal`'s shape closely.
 */
@Entity('resource_suggestion')
export class ResourceSuggestion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_resource_suggestion_member_id')
  @Column({ type: 'uuid' })
  memberId!: string;

  @Index('IDX_resource_suggestion_category')
  @Column({
    type: 'enum',
    enum: ResourceListingCategory,
    enumName: 'resource_listing_category_enum',
  })
  category!: ResourceListingCategory;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'text' })
  description!: string;

  // Contact info the suggester provides — all optional at submission time
  // (unlike `ResourceListing`, where at least one is required once an admin
  // actually publishes it).
  @Column({ type: 'varchar', length: 40, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 320, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  website!: string | null;

  @Column({
    type: 'enum',
    enum: ResourceSuggestionStatus,
    enumName: 'resource_suggestion_status_enum',
    default: ResourceSuggestionStatus.Pending,
  })
  status!: ResourceSuggestionStatus;

  // When the current `status` was decided (null while pending).
  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  // No FK — a decision is history that must outlive a staff account's
  // deletion, mirroring `ReadingGroupProposal.decidedBy`.
  @Column({ type: 'uuid', nullable: true })
  decidedBy!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  decisionNote!: string | null;

  // The `resource_listing` row this suggestion's approval produced (PRD-269),
  // or NULL for anything not approved and for the approvals decided before
  // the transition created one. No FK, on the same reasoning as `decidedBy`:
  // a listing that closes down is deleted outright, and the record that this
  // suggestion was once approved and published has to outlive that. A partial
  // unique index (see the migration) makes the duplicate guard in
  // `AdminResourceSuggestionsService.approve` hold under concurrency.
  @Column({ type: 'uuid', nullable: true })
  createdListingId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
