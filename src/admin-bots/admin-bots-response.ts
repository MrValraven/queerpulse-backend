import { User } from '../users/entities/user.entity';

/** Minimal identity of a system account for the admin picker. */
export interface AdminBotSummary {
  userId: string;
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
}

// `user.profile` is safe to dereference: every system account is created by
// `UsersService.createGoogleUser`, which inserts the profile row in the SAME
// transaction as the user (and the migration only flags the pre-existing house
// account, which already has one). So a system account without a profile cannot
// exist, and `listBots` eager-loads the relation before calling this.
export function toBotSummary(user: User): AdminBotSummary {
  return {
    userId: user.id,
    slug: user.profile.slug,
    firstName: user.profile.firstName,
    lastName: user.profile.lastName,
    avatarUrl: user.profile.avatarUrl,
  };
}
