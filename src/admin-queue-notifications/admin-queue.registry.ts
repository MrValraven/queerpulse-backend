import { UserRole } from '../users/entities/user.entity';
import { StaffRoleId } from '../users/staff-roles.registry';

/**
 * Every admin review queue an item can LAND in, as one stable vocabulary.
 *
 * A queue is here when a member's own action creates a row somebody on staff
 * then has to answer. Consoles and libraries are absent on purpose, because
 * nothing lands in them unbidden: /admin/media, /admin/topics,
 * /admin/settings, /admin/governance, /admin/press-kit,
 * /admin/landing, /admin/status-incidents, /admin/org-tiers, /admin/staff,
 * /admin/invites, /admin/mod-response-templates, /admin/bots,
 * /admin/communities, /admin/housing-groups, /admin/resource-guides,
 * /admin/resource-listings, /admin/changemakers. Also absent for the same
 * reason, though each looks like a queue at a glance, are
 * /admin/volunteer-hours and /admin/guide-feedback: an attested hours total
 * and a helpful/not-helpful tally are both reports nobody decides, not rows
 * waiting on staff.
 *
 * Three queues that DO receive arrivals are also absent, because each already
 * has a notification type of its own and a second one would double it:
 * reports (`ReportFiled`, which additionally branches copy and push on
 * `reports.severity`), ban-evasion escalations
 * (`BanEvasionEscalationRaised`), and community owner review requests
 * (`CommunityOwnerReviewRequested`).
 *
 * Values are the wire contract with the frontend's `payload.queue`, so treat
 * them as append-only: add a key when a queue is added, never rename one, or
 * old rows stop resolving to a label and to a deep link.
 */
export enum AdminQueueKey {
  InviteRequests = 'invite_requests',
  Appeals = 'appeals',
  BanRatifications = 'ban_ratifications',
  Verification = 'verification',
  Dsar = 'dsar',
  HousingListings = 'housing_listings',
  HousingGroupListings = 'housing_group_listings',
  LandlordIntroRequests = 'landlord_intro_requests',
  LandlordSuggestions = 'landlord_suggestions',
  Concerns = 'concerns',
  Intakes = 'intakes',
  LegalRequests = 'legal_requests',
  HousingCoopJoinRequests = 'housing_coop_join_requests',
  CommunityTagRequests = 'community_tag_requests',
  ReadingGroupProposals = 'reading_group_proposals',
  SafeSpaceNominations = 'safe_space_nominations',
  SafeSpaceFlags = 'safe_space_flags',
  ListingSubmissions = 'listing_submissions',
  ListingClaims = 'listing_claims',
  ListingEditSuggestions = 'listing_edit_suggestions',
  ResourceSuggestions = 'resource_suggestions',
  MagazineSubmissions = 'magazine_submissions',
  WriterApplications = 'writer_applications',
  CommissionInterests = 'commission_interests',
  PartnerApplications = 'partner_applications',
  ChangemakerNominations = 'changemaker_nominations',
  RoadmapIdeas = 'roadmap_ideas',
}

/** The lowest account tier that may work a queue. */
export type AdminQueueTier = UserRole.Moderator | UserRole.Admin;

export interface AdminQueueMeta {
  /** The frontend path the bell row deep-links to. */
  route: string;
  /**
   * `Moderator` means both staff tiers hear it; `Admin` means admins only.
   * Mirrors `MOD_ACCESSIBLE_ADMIN_PATTERNS` in the frontend's `authGate.ts`
   * and the `isAdminOnly` flag in `adminNav.data.ts`.
   */
  tier: AdminQueueTier;
  /**
   * Additive staff grants that reach this queue on their own. Mirrors
   * `CAPABILITY_ELEVATED_PATTERNS` in `authGate.ts` and the `capabilities`
   * field in `adminNav.data.ts`.
   */
  capabilities: readonly StaffRoleId[];
}

/**
 * Who hears about each queue.
 *
 * This is a MIRROR of an access map that already exists on the frontend, split
 * across `adminNav.data.ts` (which decides what a staff member is offered) and
 * `authGate.ts` (which decides what they can open). Keep all three in step.
 * A mirror that has drifted pages the wrong people, which is the shape
 * `scripts/publicPaths.mjs` drifted in eleven ways before it was caught.
 */
export const ADMIN_QUEUE_REGISTRY: Record<AdminQueueKey, AdminQueueMeta> = {
  [AdminQueueKey.InviteRequests]: {
    route: '/admin/join-requests',
    tier: UserRole.Moderator,
    capabilities: [],
  },
  [AdminQueueKey.Appeals]: {
    route: '/admin/moderation',
    tier: UserRole.Moderator,
    capabilities: [],
  },
  [AdminQueueKey.BanRatifications]: {
    route: '/admin/moderation',
    tier: UserRole.Moderator,
    capabilities: [],
  },
  [AdminQueueKey.Verification]: {
    route: '/admin/verifications',
    tier: UserRole.Moderator,
    capabilities: [],
  },
  [AdminQueueKey.Dsar]: {
    route: '/admin/dsar',
    tier: UserRole.Moderator,
    capabilities: [],
  },
  [AdminQueueKey.HousingListings]: {
    route: '/admin/housing-listings',
    tier: UserRole.Moderator,
    capabilities: ['housing_moderator'],
  },
  [AdminQueueKey.HousingGroupListings]: {
    route: '/admin/housing-group-listings',
    tier: UserRole.Moderator,
    capabilities: ['housing_moderator'],
  },
  [AdminQueueKey.LandlordIntroRequests]: {
    route: '/admin/landlords',
    tier: UserRole.Moderator,
    capabilities: [],
  },
  [AdminQueueKey.LandlordSuggestions]: {
    route: '/admin/landlords',
    tier: UserRole.Moderator,
    capabilities: [],
  },
  [AdminQueueKey.Concerns]: {
    route: '/admin/concerns',
    tier: UserRole.Admin,
    capabilities: [],
  },
  [AdminQueueKey.Intakes]: {
    route: '/admin/intakes',
    tier: UserRole.Admin,
    capabilities: [],
  },
  [AdminQueueKey.LegalRequests]: {
    route: '/admin/legal-requests',
    tier: UserRole.Admin,
    capabilities: [],
  },
  [AdminQueueKey.HousingCoopJoinRequests]: {
    route: '/admin/housing',
    tier: UserRole.Admin,
    capabilities: [],
  },
  [AdminQueueKey.CommunityTagRequests]: {
    route: '/admin/community-tag-requests',
    tier: UserRole.Admin,
    capabilities: ['communities'],
  },
  [AdminQueueKey.ReadingGroupProposals]: {
    route: '/admin/reading-group-proposals',
    tier: UserRole.Admin,
    capabilities: ['communities'],
  },
  [AdminQueueKey.SafeSpaceNominations]: {
    route: '/admin/safe-spaces',
    tier: UserRole.Admin,
    capabilities: ['directory_moderator'],
  },
  [AdminQueueKey.SafeSpaceFlags]: {
    // NO capability, and this is load-bearing.
    // `CAPABILITY_ELEVATED_PATTERNS` opens /admin/safe-spaces to a
    // `directory_moderator`, but the flag queue itself is excluded on the
    // backend: it is the only surface that serves a flagger's identity and
    // their free text. A grant holder hears about a nomination and never
    // about a flag.
    route: '/admin/safe-spaces',
    tier: UserRole.Admin,
    capabilities: [],
  },
  [AdminQueueKey.ListingSubmissions]: {
    route: '/admin/listings',
    tier: UserRole.Admin,
    capabilities: ['directory_moderator'],
  },
  [AdminQueueKey.ListingClaims]: {
    route: '/admin/listings',
    tier: UserRole.Admin,
    capabilities: ['directory_moderator'],
  },
  [AdminQueueKey.ListingEditSuggestions]: {
    route: '/admin/listings',
    tier: UserRole.Admin,
    capabilities: ['directory_moderator'],
  },
  [AdminQueueKey.ResourceSuggestions]: {
    route: '/admin/resource-suggestions',
    tier: UserRole.Admin,
    capabilities: ['resource_curator'],
  },
  [AdminQueueKey.MagazineSubmissions]: {
    route: '/admin/magazine-submissions',
    tier: UserRole.Admin,
    capabilities: ['editorial'],
  },
  [AdminQueueKey.WriterApplications]: {
    route: '/admin/writer-applications',
    tier: UserRole.Admin,
    capabilities: ['editorial'],
  },
  [AdminQueueKey.CommissionInterests]: {
    route: '/admin/commission-interests',
    tier: UserRole.Admin,
    capabilities: ['editorial'],
  },
  [AdminQueueKey.PartnerApplications]: {
    route: '/admin/partner-applications',
    tier: UserRole.Admin,
    capabilities: ['partnerships'],
  },
  [AdminQueueKey.ChangemakerNominations]: {
    route: '/admin/changemaker-nominations',
    tier: UserRole.Admin,
    capabilities: ['partnerships'],
  },
  [AdminQueueKey.RoadmapIdeas]: {
    // `AdminRoadmapController` itself is `@Roles(Admin, Moderator)`, but the
    // frontend's `MOD_ACCESSIBLE_ADMIN_PATTERNS` does not list
    // `/admin/roadmap`, so a moderator who followed this deep link would be
    // bounced by the route gate. The registry mirrors what a staff member can
    // actually OPEN, not what the backend controller alone would allow, so
    // the tier here is narrower than the controller's own guard.
    route: '/admin/roadmap',
    tier: UserRole.Admin,
    capabilities: [],
  },
};

/** Every queue, in declaration order. */
export const ADMIN_QUEUE_KEYS: readonly AdminQueueKey[] =
  Object.values(AdminQueueKey);
