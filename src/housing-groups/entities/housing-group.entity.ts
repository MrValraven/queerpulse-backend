import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { GroupJoinRequest } from './group-join-request.entity';
import { GroupListing } from './group-listing.entity';

/**
 * A screening question a prospective member answers when asking to join an
 * access-gated group. Snapshotted onto the join request at submission time (see
 * `GroupJoinRequest.answers`) so an admin always reads the exact prompt the
 * applicant saw, even after a steward later edits the group's questions.
 */
export interface GroupScreeningQuestion {
  /** Stable id used to line answers up with prompts. */
  id: string;
  prompt: string;
  /** Whether an answer is mandatory (enforced in the create DTO). */
  required: boolean;
}

/**
 * A vetted, access-gated community housing group — the Facebook-group trust
 * model queer renters already rely on, made a first-class product object. A
 * moderator/steward screens prospective members (`GroupJoinRequest`) and the
 * group enforces its published `norms` on the listings shared inside it
 * (`GroupListing`).
 */
@Entity('housing_groups')
export class HousingGroup {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_housing_groups_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'varchar', nullable: true })
  nameEm!: string | null;

  @Column({ type: 'varchar' })
  city!: string;

  @Column({ type: 'text' })
  blurb!: string;

  /**
   * When true, joining requires an approved `GroupJoinRequest`. When false the
   * group is an open reading room. Access-gated is the safe default.
   */
  @Column({ type: 'boolean', default: true })
  isAccessGated!: boolean;

  /** The enforced community norms, surfaced on the group page. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  norms!: string[];

  /** Screening questions shown in the join-with-screening modal. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  screeningQuestions!: GroupScreeningQuestion[];

  /**
   * DERIVED, never client-supplied: the number of `group_join_requests` rows
   * for this group with status `approved`. Maintained by
   * `HousingGroupsService.refreshMemberCount` on every triage decision and
   * deliberately absent from `CreateHousingGroupDto`/`UpdateGroupDto` — it used to be
   * an admin-typed integer, which made the public "N members" figure disagree
   * with the roster the admin queue reads.
   */
  @Column({ type: 'int', default: 0 })
  memberCount!: number;

  @Column({ type: 'boolean', default: false })
  published!: boolean;

  @OneToMany(() => GroupJoinRequest, (request) => request.group)
  joinRequests!: GroupJoinRequest[];

  @OneToMany(() => GroupListing, (listing) => listing.group)
  listings!: GroupListing[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
