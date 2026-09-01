import { UserRole } from '../users/entities/user.entity';
import { STAFF_ROLE_IDS, StaffRoleId } from '../users/staff-roles.registry';
import {
  ADMIN_QUEUE_KEYS,
  ADMIN_QUEUE_REGISTRY,
  AdminQueueKey,
  AdminQueueTier,
} from './admin-queue.registry';

/**
 * The expected table, written out longhand rather than derived from the
 * registry, so an edit to the registry has to be a deliberate edit in two
 * places. The same table is asserted on the frontend in
 * `queerpulse/src/features/notifications/api/adminQueueRoutes.test.ts`; the
 * two must agree, because between them they are the whole contract.
 */
const EXPECTED: Record<
  AdminQueueKey,
  { route: string; tier: AdminQueueTier; capabilities: readonly StaffRoleId[] }
> = {
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
    route: '/admin/roadmap',
    tier: UserRole.Admin,
    capabilities: [],
  },
};

describe('ADMIN_QUEUE_REGISTRY', () => {
  it('covers every key exactly once', () => {
    // 27 as of RoadmapIdeas. The frontend mirror at adminQueueRoutes.ts
    // carries the same 27 keys, and the two sides have to agree.
    expect(ADMIN_QUEUE_KEYS).toHaveLength(27);
    expect(new Set(ADMIN_QUEUE_KEYS).size).toBe(27);
    expect(Object.keys(ADMIN_QUEUE_REGISTRY).sort()).toEqual(
      [...ADMIN_QUEUE_KEYS].sort(),
    );
  });

  it('matches the expected access table', () => {
    for (const queueKey of ADMIN_QUEUE_KEYS) {
      const entry = ADMIN_QUEUE_REGISTRY[queueKey];
      const expected = EXPECTED[queueKey];
      expect({
        route: entry.route,
        tier: entry.tier,
        capabilities: [...entry.capabilities],
      }).toEqual(expected);
    }
  });

  it('only names real staff grants', () => {
    for (const queueKey of ADMIN_QUEUE_KEYS) {
      for (const capability of ADMIN_QUEUE_REGISTRY[queueKey].capabilities) {
        expect(STAFF_ROLE_IDS).toContain(capability);
      }
    }
  });

  it('never grants the safe-space flag queue to a directory moderator', () => {
    // The flag queue is the only surface serving a flagger's identity and
    // free text, and it is deliberately excluded from the
    // `directory_moderator` grant that opens the rest of /admin/safe-spaces.
    // Copying the nomination row's capabilities onto this one would tell a
    // grant holder that a flag exists on a space they may have listed.
    expect(
      ADMIN_QUEUE_REGISTRY[AdminQueueKey.SafeSpaceFlags].capabilities,
    ).toEqual([]);
  });

  it('keeps the legal register admin-only', () => {
    // `AdminLegalRequestsController` is `@Roles(Admin)` alone and the path is
    // absent from `MOD_ACCESSIBLE_ADMIN_PATTERNS`. The rail hides it from a
    // moderator with `isAdminOnly`; the bell has to hide it too, because its
    // mere presence says something the register is meant to keep narrow.
    expect(ADMIN_QUEUE_REGISTRY[AdminQueueKey.LegalRequests].tier).toBe(
      UserRole.Admin,
    );
  });
});
