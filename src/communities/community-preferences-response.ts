import { CommunityNotificationLevel } from './entities/community-member.entity';

/**
 * `GET /communities/:slug/preferences` and the echo from
 * `PATCH /communities/:slug/preferences`.
 *
 * Strictly the CALLER'S OWN relationship with one community. It carries no
 * other member's preference and no roster information, because a member's
 * notification level is their own business and nobody else's: an owner has no
 * read on who muted them, by design.
 *
 * `welcomeMessage` and `shouldShowWelcome` ride along so the community page
 * needs ONE call to decide whether to greet the viewer, instead of a
 * preferences read plus a separate welcome-state read. `shouldShowWelcome` is
 * the whole decision already made server-side (the member has never been
 * stamped AND the community actually authored a non-empty welcome), so the
 * client never has to re-derive the rule and drift from it.
 */
export interface CommunityPreferencesResponse {
  communitySlug: string;
  notificationLevel: CommunityNotificationLevel;
  /** The owner-authored greeting, or null when the community has none. */
  welcomeMessage: string | null;
  /** True while this member still owes a first read of `welcomeMessage`. */
  shouldShowWelcome: boolean;
  /** When this member was last shown the welcome, or null if never. */
  welcomeSeenAt: Date | null;
  /**
   * The community's current house-rules version, and the version this member
   * last accepted (null for anyone who joined before acceptance was recorded).
   *
   * These ride along for the same reason the welcome fields do: the community
   * page needs ONE call to decide whether to prompt the viewer.
   * `shouldReacceptRules` is the decision already made server-side (the
   * community actually has rules AND this member's accepted version is behind
   * the current one), so no client re-derives the rule and drifts from it.
   */
  rulesVersion: number;
  rulesAcceptedVersion: number | null;
  /** True while this member owes a fresh read of rules that have changed. */
  shouldReacceptRules: boolean;
}
