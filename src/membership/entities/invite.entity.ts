import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum InviteStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Revoked = 'revoked',
  Expired = 'expired',
}

@Entity('invites')
export class Invite {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  inviterId: string;

  @Index({ unique: true })
  @Column({ type: 'varchar' })
  code: string;

  @Column({ type: 'varchar', nullable: true })
  email: string | null;

  // Personal message the inviter writes at POST /invites; surfaced to the
  // recipient on the public invite-resolution endpoint. Capped at 200 chars.
  @Column({ type: 'varchar', length: 200, nullable: true })
  note: string | null;

  // The inviter's "why I'm inviting you" message, shown to the recipient on the
  // onboarding welcome step. Surfaced on the public invite-resolution endpoint.
  // Capped at 280 chars.
  @Column({ type: 'varchar', length: 280, nullable: true })
  vouch: string | null;

  // True for an invite a member created themselves; false for one the system
  // minted for them (admin join-request approval, genesis bootstrap). Only
  // personal invites auto-vouch the inviter for the redeeming member at signup.
  @Column({ type: 'boolean', default: true })
  personal: boolean;

  @Column({
    type: 'enum',
    enum: InviteStatus,
    enumName: 'invites_status_enum',
    default: InviteStatus.Pending,
  })
  status: InviteStatus;

  // Who redeemed the invite (the recipient). Doubles as "used_by".
  @Column({ type: 'uuid', nullable: true })
  acceptedBy: string | null;

  // When the invite was redeemed; null while still valid.
  @Column({ type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
