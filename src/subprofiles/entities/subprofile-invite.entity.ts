import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum SubprofileInviteStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
  Revoked = 'revoked',
}

// One PENDING invite per (subprofile, invitee) is enforced by a PARTIAL unique
// index created in the migration (TypeORM `@Unique` can't express a WHERE); this
// entity intentionally declares no full unique so accepted/declined/revoked rows
// can coexist for the same pair (a re-invite after a decline is allowed).
@Index('IDX_subprofile_invites_subprofile_id', ['subprofileId'])
@Index('IDX_subprofile_invites_invited_user_id', ['invitedUserId'])
// The inviter FK had no supporting index (CNT-20): Postgres does not index a
// foreign-key column automatically, so every hard delete of a `users` row (the
// account-erasure path) had to sequentially scan this table. Created by
// `1793640000000-AddContentModuleForeignKeyIndexes`.
@Index('IDX_subprofile_invites_invited_by_user_id', ['invitedByUserId'])
@Entity('subprofile_invites')
export class SubprofileInvite {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  subprofileId!: string;

  @Column({ type: 'uuid' })
  invitedUserId!: string;

  @Column({ type: 'uuid' })
  invitedByUserId!: string;

  @Column({
    type: 'enum',
    enum: SubprofileInviteStatus,
    enumName: 'subprofile_invites_status_enum',
    default: SubprofileInviteStatus.Pending,
  })
  status!: SubprofileInviteStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;
}
