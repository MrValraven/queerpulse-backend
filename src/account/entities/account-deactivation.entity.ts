import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { UserStatus } from '../../users/entities/user.entity';

// Reversible, non-erasure account pause (`POST /account/deactivate`).
//
// This row is the *ledger* of the pause (when it started, when it ended, what
// to restore to). The hiding itself is done by `users.status =
// UserStatus.Deactivated`, which `AccountService.deactivate` sets in the same
// transaction — that is what every existing `status = 'active'` predicate
// (directory, feed, member refs, `ActiveMemberGuard`, the chat handshake)
// already keys off. An earlier version of this comment said the table existed
// *because* `UserStatus` had no value for it; that is no longer true, and the
// two must be written together or the member is hidden with no way back (or,
// worse, has a way back without ever being hidden).
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

  /**
   * The `users.status` this member held when they deactivated, so reactivation
   * puts them back exactly where they were.
   *
   * SECURITY: this is why reactivation must not hardcode `Active`. A
   * **suspended** member can reach `POST /account/deactivate` (the account
   * controller is deliberately JWT-only, no `ActiveMemberGuard`), so without
   * this column deactivating and signing back in would be a one-click way to
   * launder away a moderation suspension.
   *
   * Never holds `Deactivated` itself — re-deactivating an already-deactivated
   * member preserves the original value rather than overwriting it with the
   * status that is being *replaced*.
   *
   * Nullable only because the column post-dates the table; the migration
   * backfills every existing row from `users.status`. A NULL that somehow
   * survives is treated as `Active` on restore.
   */
  @Column({
    type: 'enum',
    enum: UserStatus,
    enumName: 'users_status_enum',
    nullable: true,
  })
  previousStatus: UserStatus | null;
}
