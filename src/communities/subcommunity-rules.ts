import { IsNull, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { AccessTier } from './entities/community.entity';
import { RosterRole } from './entities/community-member.entity';

/**
 * Subcommunities ("spaces" in the UI) are one level deep: a `Community` row
 * whose `parentId` points at a top-level community. These helpers are the
 * single source for the three rules every caller must agree on: how strict a
 * tier is, what role a caller effectively holds inside a space, and how a
 * listing query keeps spaces out.
 */

export const SUBCOMMUNITIES_NOT_ALLOWED_CODE = 'SUBCOMMUNITIES_NOT_ALLOWED';
export const SUBCOMMUNITY_TIER_TOO_OPEN_CODE = 'SUBCOMMUNITY_TIER_TOO_OPEN';
export const PARENT_MEMBERSHIP_REQUIRED_CODE = 'PARENT_MEMBERSHIP_REQUIRED';
/**
 * A feature a space leaves out in v1 (volunteering, support offers,
 * membership cards) was asked of a space.
 */
export const SUBCOMMUNITY_FEATURE_UNAVAILABLE_CODE =
  'SUBCOMMUNITY_FEATURE_UNAVAILABLE';
/** A space request was filed for a community that already hosts spaces. */
export const SPACES_ALREADY_ALLOWED_CODE = 'SPACES_ALREADY_ALLOWED';
/** A space request was filed while another one is still open. */
export const SPACE_REQUEST_ALREADY_OPEN_CODE = 'SPACE_REQUEST_ALREADY_OPEN';
/** An admin tried to approve or decline a request that is no longer open. */
export const SPACE_REQUEST_NOT_OPEN_CODE = 'SPACE_REQUEST_NOT_OPEN';

export const TIER_STRICTNESS: Record<AccessTier, number> = {
  [AccessTier.Public]: 0,
  [AccessTier.Request]: 1,
  [AccessTier.Invite]: 2,
  [AccessTier.Private]: 3,
};

export function isTierAtLeastAsStrict(
  childTier: AccessTier,
  parentTier: AccessTier,
): boolean {
  return TIER_STRICTNESS[childTier] >= TIER_STRICTNESS[parentTier];
}

const ROLE_RANK: Record<RosterRole, number> = {
  [RosterRole.Member]: 0,
  [RosterRole.Mod]: 1,
  [RosterRole.CoOwner]: 2,
  [RosterRole.Owner]: 3,
};

function inheritedRoleFromParent(
  parentRole: RosterRole | null,
): RosterRole | null {
  if (parentRole === RosterRole.Owner || parentRole === RosterRole.CoOwner) {
    return RosterRole.CoOwner;
  }
  if (parentRole === RosterRole.Mod) return RosterRole.Mod;
  return null;
}

/**
 * The role a caller effectively holds. Top-level: their own roster role.
 * Space: null without a parent roster row (a leftover space row a cascade
 * missed grants nothing), otherwise the higher of their own space role and
 * the role inherited from parent staff. Inheritance writes no roster row.
 */
export function resolveEffectiveRole(input: {
  isSpace: boolean;
  ownRole: RosterRole | null;
  parentRole: RosterRole | null;
}): RosterRole | null {
  const { isSpace, ownRole, parentRole } = input;
  if (!isSpace) return ownRole;
  if (parentRole === null) return null;
  const inheritedRole = inheritedRoleFromParent(parentRole);
  if (ownRole === null) return inheritedRole;
  if (inheritedRole === null) return ownRole;
  return ROLE_RANK[ownRole] >= ROLE_RANK[inheritedRole]
    ? ownRole
    : inheritedRole;
}

/** `where` fragment for `find`/`count` calls that must skip spaces. */
export const TOP_LEVEL_WHERE = { parentId: IsNull() } as const;

/**
 * Appends `<alias>.parent_id IS NULL`. Every query that lists or counts
 * communities to a person uses this, so `grep -L topLevelOnly` over the
 * listing files is the audit.
 */
export function topLevelOnly<Entity extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<Entity>,
  alias: string,
): SelectQueryBuilder<Entity> {
  return queryBuilder.andWhere(`${alias}.parent_id IS NULL`);
}

/**
 * The staff roles (owner, co-owner, mod). In a parent they carry mod powers
 * into every space of that parent; in a space they see it past a takedown.
 */
const STAFF_ROLES: readonly RosterRole[] = [
  RosterRole.Owner,
  RosterRole.CoOwner,
  RosterRole.Mod,
];

/**
 * Whether a space shows up for a viewer on its parent's page: in the
 * `GET :slug/subcommunities` list and in the parent's `subcommunityCount`, so
 * the tab badge never counts a space the list withholds. A private space
 * exists only for viewers holding an effective role in it (own roster row, or
 * inherited from parent staff). A space under a moderator takedown shows only
 * to its staff, the line `getBySlug` draws.
 */
export function isSpaceVisibleTo(input: {
  accessTier: AccessTier;
  viewerRole: RosterRole | null;
  isTakenDown: boolean;
}): boolean {
  const { accessTier, viewerRole, isTakenDown } = input;
  if (accessTier === AccessTier.Private && viewerRole === null) return false;
  if (!isTakenDown) return true;
  return viewerRole !== null && STAFF_ROLES.includes(viewerRole);
}

// Enum values only, so inlining them as SQL literals is safe and keeps the
// callers' bound parameters unchanged.
const PARENT_STAFF_ROLES_SQL = STAFF_ROLES.map((role) => `'${role}'`).join(
  ', ',
);

/**
 * SQL for "the viewer's roster row in this community counts": always at top
 * level, and inside a space only while the viewer still holds a parent roster
 * row (the spec's double check, so a leftover space row a cascade missed
 * grants nothing). `communityIdSql` is the column holding the community id,
 * `viewerParam` the bound viewer id parameter name without its colon.
 */
export function ownRosterRowCountsSql(
  communityIdSql: string,
  viewerParam: string,
): string {
  return `EXISTS (
    SELECT 1 FROM "communities" "own_c"
    WHERE "own_c"."id" = ${communityIdSql}
      AND (
        "own_c"."parent_id" IS NULL
        OR EXISTS (
          SELECT 1 FROM "community_members" "own_pm"
          WHERE "own_pm"."community_id" = "own_c"."parent_id"
            AND "own_pm"."user_id" = :${viewerParam}
        )
      )
  )`;
}

/**
 * SQL for "the viewer is staff (owner, co-owner or mod) of this space's
 * parent", the inherited role that reaches every space with no space roster
 * row. False for a top-level community.
 */
export function parentStaffOfSpaceSql(
  communityIdSql: string,
  viewerParam: string,
): string {
  return `EXISTS (
    SELECT 1 FROM "communities" "staff_sc"
    JOIN "community_members" "staff_pm"
      ON "staff_pm"."community_id" = "staff_sc"."parent_id"
    WHERE "staff_sc"."id" = ${communityIdSql}
      AND "staff_pm"."user_id" = :${viewerParam}
      AND "staff_pm"."role" IN (${PARENT_STAFF_ROLES_SQL})
  )`;
}
