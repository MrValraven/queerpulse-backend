import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// Mirrors the `<select id="ss-format">` options in the frontend's
// `ListGroupStrip.tsx` ("Start your own group" strip on the Reading Groups
// page).
export enum ReadingGroupProposalFormat {
  InPerson = 'In-person',
  Online = 'Online',
  Either = 'Either',
}

/**
 * Admin decision lifecycle for a member-submitted proposal. `pending` is the
 * state every new proposal is created in (the member-facing write never sets
 * it); an admin/moderator then approves, declines, or archives it from the
 * oversight surface, which stamps `decidedAt`/`decidedBy` (see the admin
 * controller). Backed by migration `AddReadingGroupProposalStatus1786000600000`.
 */
export enum ReadingGroupProposalStatus {
  Pending = 'pending',
  Approved = 'approved',
  Declined = 'declined',
  Archived = 'archived',
}

/**
 * A member proposing a new reading group (see `ListGroupStrip.tsx` — "Start
 * your own group" on the Reading Groups page). The reading-group directory
 * itself (`GROUPS` in `readingGroups.data.ts`) is curated editorial content
 * with no `reading_group` table to reference, so this row is the genuine
 * member-submitted proposal, denormalized just like `CommissionInterest`
 * denormalizes the commission it targets.
 */
@Entity('reading_group_proposal')
export class ReadingGroupProposal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_reading_group_proposal_member_id')
  @Column({ type: 'uuid' })
  memberId!: string;

  // The form's "Book title & author" input, entered as free text (e.g.
  // "Giovanni's Room — James Baldwin").
  @Column({ type: 'varchar', length: 200 })
  book!: string;

  // The form's optional "Why this book?" input.
  @Column({ type: 'varchar', length: 500, nullable: true })
  why!: string | null;

  @Column({ type: 'enum', enum: ReadingGroupProposalFormat })
  format!: ReadingGroupProposalFormat;

  // The form's "Max people" select (4, 6, or 8).
  @Column({ type: 'smallint' })
  maxPeople!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  // Admin decision lifecycle. A fresh proposal is always `pending`; an
  // admin/moderator transitions it via the admin controller, which also stamps
  // the who/when below.
  @Column({
    type: 'enum',
    enum: ReadingGroupProposalStatus,
    default: ReadingGroupProposalStatus.Pending,
  })
  status!: ReadingGroupProposalStatus;

  // When the current `status` was decided (null while still pending).
  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  // The admin/moderator (`users.id`) who made the current decision (null while
  // still pending). No FK — a decision is history that must outlive a staff
  // account's deletion, mirroring how `deletion_request` keeps no user FK.
  @Column({ type: 'uuid', nullable: true })
  decidedBy!: string | null;

  // Optional free-text note the deciding admin/moderator attached to the
  // decision (e.g. why a proposal was declined).
  @Column({ type: 'varchar', length: 500, nullable: true })
  decisionNote!: string | null;
}
