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
  id: string;

  @Index('IDX_reading_group_proposal_member_id')
  @Column({ type: 'uuid' })
  memberId: string;

  // The form's "Book title & author" input, entered as free text (e.g.
  // "Giovanni's Room — James Baldwin").
  @Column({ type: 'varchar', length: 200 })
  book: string;

  // The form's optional "Why this book?" input.
  @Column({ type: 'varchar', length: 500, nullable: true })
  why: string | null;

  @Column({ type: 'enum', enum: ReadingGroupProposalFormat })
  format: ReadingGroupProposalFormat;

  // The form's "Max people" select (4, 6, or 8).
  @Column({ type: 'smallint' })
  maxPeople: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
