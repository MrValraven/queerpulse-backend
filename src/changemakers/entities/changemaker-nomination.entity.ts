import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum ChangemakerNominationStatus {
  Pending = 'pending',
  Approved = 'approved',
  Dismissed = 'dismissed',
}

/**
 * A member nominating someone for the Change Makers directory (see the
 * "Nominate them" form in `ChangemakersPage.tsx`). The directory itself
 * (`CHANGEMAKERS`) is curated editorial content with no `changemaker` table
 * to reference — the nominee's name (and, since COM-16, a short reason) is
 * denormalized here the same way `CommissionInterest` denormalizes its
 * target. Triaged by an admin (COM-17: this used to be a one-way black
 * hole — a submit toast, then silence forever), mirroring
 * `MagazineWriterApplication`'s pending/approved/declined shape, renamed
 * approved/dismissed here since there's no role grant riding on the
 * decision, just a yes/no on the directory pitch.
 */
@Entity('changemaker_nomination')
export class ChangemakerNomination {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_changemaker_nomination_nominator_id')
  @Column({ type: 'uuid' })
  nominatorId!: string;

  // The form's first field: "Their name…".
  @Column({ type: 'varchar', length: 200 })
  nomineeName!: string;

  // The form's second field, added for COM-16 — the copy promises "a name
  // and a sentence is enough to start"; this is that sentence. Nullable:
  // rows submitted before this field existed have nothing to backfill.
  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  // COM-18: the nominee, when they are already a member here. The form's
  // member search submits a profile `slug`; the service resolves it to this
  // user id so the admin queue can render a real profile the reviewer can
  // open. No FK, mirroring `nominatorId` above — a dangling id resolves to no
  // `MemberRef` and the row reads "A former member".
  @Index('IDX_changemaker_nomination_nominee_user_id')
  @Column({ type: 'uuid', nullable: true })
  nomineeUserId!: string | null;

  // COM-18: where to find a nominee who is NOT a member — an Instagram
  // handle, a website, an email. Free text on purpose: a reviewer needs
  // whatever the nominator actually knows, and the platform has no business
  // insisting a stranger's presence online fit one shape.
  @Column({ type: 'varchar', length: 200, nullable: true })
  nomineeContact!: string | null;

  @Column({
    type: 'enum',
    enum: ChangemakerNominationStatus,
    enumName: 'changemaker_nomination_status_enum',
    default: ChangemakerNominationStatus.Pending,
  })
  status!: ChangemakerNominationStatus;

  @Column({ type: 'uuid', nullable: true })
  reviewedBy!: string | null;

  @Column({ type: 'text', nullable: true })
  reviewNote!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
