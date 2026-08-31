import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Lifecycle of a "suggest a tag" request. `pending` is the state every new
 * request is created in; an admin then marks it `resolved` once they've
 * acted on it (or decided not to) in a future, separate, code-reviewed
 * change to `COMMUNITY_TAGS` — see this entity's own docstring for why
 * resolving a request never writes to that vocabulary directly.
 */
export enum CommunityTagRequestStatus {
  Pending = 'pending',
  Resolved = 'resolved',
}

/**
 * A community owner/mod's free-text "I wish this tag existed" feedback
 * (`POST /communities/:slug/tag-requests`), reviewed by an admin from the
 * `admin/community-tag-requests` inbox. INFORMATIONAL ONLY: resolving a
 * request flips its `status` and notifies the requester, but does NOT add
 * anything to the live `COMMUNITY_TAGS` vocabulary
 * (`src/communities/community-tags.ts`), which stays a hardcoded,
 * code-reviewed array by deliberate product decision — this table is purely
 * a feedback inbox for admins to read and act on manually. Mirrors
 * `ResourceSuggestion`'s member-authored / admin-reviewed shape, but simpler:
 * two statuses, not four, and no category taxonomy.
 */
@Entity('community_tag_request')
export class CommunityTagRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_community_tag_request_community_id')
  @Column({ type: 'uuid' })
  communityId!: string;

  // FK-backed as of `AddCommunityTagRequestUserForeignKeys1795811000000` with
  // `ON DELETE CASCADE`, replacing an earlier plain-`uuid` column justified as
  // "history should outlive the account". It does not: a tag request is a
  // one-person loop that changes nothing (see this class's docstring) and
  // closes with a notification back to whoever filed it, so with that person
  // erased the row is a dead letter carrying their free text. Stays NOT NULL,
  // which is what the resolve notification's recipient relies on.
  @Index('IDX_community_tag_request_requested_by_user_id')
  @Column({ type: 'uuid' })
  requestedByUserId!: string;

  // Capped to 60 chars at the DTO layer (`CreateCommunityTagRequestDto`);
  // the column mirrors that cap rather than leaving it unbounded.
  @Column({ type: 'varchar', length: 60 })
  label!: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  note!: string | null;

  @Index('IDX_community_tag_request_status')
  @Column({
    type: 'enum',
    enum: CommunityTagRequestStatus,
    enumName: 'community_tag_request_status_enum',
    default: CommunityTagRequestStatus.Pending,
  })
  status!: CommunityTagRequestStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  // Null while pending; stamped together with `resolvedByUserId` when an
  // admin resolves the request.
  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  // FK-backed as of `AddCommunityTagRequestUserForeignKeys1795811000000` with
  // `ON DELETE SET NULL`, matching `mod_audit_logs.actor_id` and
  // `listing_edit_suggestions.resolvedByUserId`: a moderation stamp survives
  // erasure severed from the person, so an erased admin neither takes the
  // record of their decisions with them nor takes other people's pending
  // feedback down on the way out.
  @Index('IDX_community_tag_request_resolved_by_user_id')
  @Column({ type: 'uuid', nullable: true })
  resolvedByUserId!: string | null;
}
