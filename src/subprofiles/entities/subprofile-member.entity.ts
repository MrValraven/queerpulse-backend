import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('subprofile_members')
@Unique('UQ_subprofile_members', ['subprofileId', 'userId'])
export class SubprofileMember {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_subprofile_members_subprofile_id')
  @Column({ type: 'uuid' })
  subprofileId!: string;

  @Index('IDX_subprofile_members_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  // Where this persona sits in THIS member's own list, zero-based. Ordering
  // is a per-member preference about a member's own profile page, so it lives
  // here rather than on `subprofiles.position`: a co-owned persona appears
  // under every co-owner's profile, and one shared column meant either
  // co-owner reordering their page silently reshuffled the other's. Written
  // only by `SubprofilesService.reorderMine` (the single writer of ordering);
  // read by `SubprofilesService.listMine` and
  // `SubprofilePublicReadService.listForProfile`, both of which sort in
  // memory over the member rows they already fetch. Gaps and duplicates are
  // harmless to the reads, which fall back to `createdAt` ASC as the
  // deterministic tiebreak. See migration
  // `1817210000000-AddSubprofileMemberPosition`.
  @Column({ type: 'int', default: 0 })
  position!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  joinedAt!: Date;
}
