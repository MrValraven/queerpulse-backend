import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum EmailSignInChallengePurpose {
  SignIn = 'sign_in',
  Reauth = 'reauth',
}

/**
 * One emailed 6-digit sign-in code, waiting to be typed back.
 *
 * The code itself is stored only as an HMAC-SHA256 hex digest bound to this
 * row's `id`, and the address is stored normalized (`trim().toLowerCase()`).
 *
 * The DDL in `1837500000000-AddEmailCodeSignIn` is authoritative for the
 * indexes, the check constraint and the foreign key to `users`. The
 * decorators below mirror it by name so `migration:generate` sees no drift.
 */
@Entity('email_sign_in_challenges')
@Check('CHK_email_sign_in_challenges_failed_attempts', `"failed_attempts" >= 0`)
// Per-address caps.
@Index('IDX_email_sign_in_challenges_email_created_at', ['email', 'createdAt'])
// Per-requester limits and supersede.
@Index('IDX_email_sign_in_challenges_requester', [
  'requesterHash',
  'email',
  'purpose',
  'createdAt',
])
// Purge.
@Index('IDX_email_sign_in_challenges_expires_at', ['expiresAt'])
export class EmailSignInChallenge {
  // Minted by the service (randomUUID) so the HMAC can bind to it.
  @PrimaryColumn('uuid', {
    primaryKeyConstraintName: 'PK_email_sign_in_challenges',
  })
  id!: string;

  @Column({
    type: 'enum',
    enum: EmailSignInChallengePurpose,
    enumName: 'email_sign_in_challenge_purpose_enum',
  })
  purpose!: EmailSignInChallengePurpose;

  // Normalized address.
  @Column({ type: 'varchar', length: 254 })
  email!: string;

  // Set for reauth only.
  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_email_sign_in_challenges_user',
  })
  user?: User | null;

  // sha256 hex of the requester cookie.
  @Column({ type: 'varchar', length: 64 })
  requesterHash!: string;

  // HMAC-SHA256 hex of the code.
  @Column({ type: 'varchar', length: 64 })
  codeHash!: string;

  @Column({ type: 'integer', default: 0 })
  failedAttempts!: number;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  supersededAt!: Date | null;

  // Set explicitly by the service.
  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
