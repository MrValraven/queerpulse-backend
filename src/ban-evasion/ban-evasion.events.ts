import { RemovalKind } from './entities/removed-account-signal.entity';

/**
 * The one event the ban-evasion module listens for.
 *
 * Emitted by whoever actually closes a door on an account: the platform
 * enforcement path when a `ban` lands, and the community bans service when a
 * community ban lands. Those services own their own transactions and their own
 * files, so this module never reaches into them. It listens, and does its
 * writing on its own.
 *
 * Emit AFTER the ban has committed. The listener does an independent write and
 * a failure inside it must never roll back the ban itself: a ban that took
 * effect with no evasion record is a missing flag later, while a ban that got
 * rolled back because a flag failed to record is a member walking free now.
 */
export const ACCOUNT_REMOVED = 'ban_evasion.account_removed';

export interface AccountRemovedEvent {
  /** The account that was removed. */
  userId: string;
  removalKind: RemovalKind;
  /** The community for a community ban; null for a platform ban. */
  communityId: string | null;
  /** When the removal landed. */
  removedAt: Date;
}
