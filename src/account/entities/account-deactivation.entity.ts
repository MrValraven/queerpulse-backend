import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Reversible, non-erasure account pause (`POST /account/deactivate`). Kept as
// its own table rather than a `users.status` value: `UserStatus` is
// `pending|active|suspended` and is owned by `src/users`/`src/auth` (out of
// scope to edit here) — member-initiated deactivation is a distinct concept
// from moderation suspension.
@Entity('account_deactivation')
export class AccountDeactivation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', unique: true })
  userId: string;

  @Column({ type: 'timestamptz' })
  deactivatedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  reactivatedAt: Date | null;
}
