import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// A short-lived, single-purpose step-up token minted by `POST
// /account/reauth`. Auth is OAuth-only — there is no password to re-verify —
// so this simply records that the caller re-confirmed their session
// recently. The destructive/export routes below require a live (unexpired)
// token belonging to the caller.
@Entity('account_reauth_token')
export class AccountReauthToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_account_reauth_token_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Index({ unique: true })
  @Column({ type: 'varchar' })
  token: string;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
