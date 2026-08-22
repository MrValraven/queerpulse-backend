import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// A short-lived, single-purpose step-up token.
//
// Minted ONLY by `AuthService.mintReauthToken`, reached through the Google
// OAuth callback's `reauth` branch. There is no plain `POST /account/reauth`
// route: one existed, and it handed out a step-up token to anyone holding the
// session cookie, which is exactly the thing step-up auth is supposed to be
// independent of. Requiring a completed OAuth round trip (`prompt=login`) is
// what makes the token mean "this person can sign in RIGHT NOW".
//
// The `token` column holds a SHA-256 hash, never the value handed to the
// client. The destructive/export routes require a live (unexpired, unconsumed)
// token belonging to the caller; `AccountService.assertReauth` consumes it.
@Entity('account_reauth_token')
export class AccountReauthToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_account_reauth_token_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Index('UQ_account_reauth_token_token', { unique: true })
  @Column({ type: 'varchar' })
  token!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
