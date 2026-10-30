import { EntityManager, In } from 'typeorm';
import { MediaCropService } from '../media-crops/media-crops.service';
import {
  Subprofile,
  SubprofileLinkVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { Profile } from '../users/entities/profile.entity';
import { ListingTeamMemberStatus } from './entities/listing-team-member.entity';
import {
  memberAvatarKeys,
  ownerNameOf,
  personaAvatarKeys,
  toListingTeamMemberProfile,
  toListingTeamMemberPublic,
  toListingTeamPersona,
  toListingTeamPersonaPublic,
  type ListingTeamMemberColumns,
  type ListingTeamMemberPublic,
} from './listing-team-response';
import { LISTING_TEAM_LIMITS } from './listing-team.constants';
import {
  anonymousVisibleMemberSql,
  anonymousVisiblePersonaSql,
  eligibleMemberSql,
  eligiblePersonaSql,
  notBlockedEitherWaySql,
  notHiddenFromViewerSql,
} from './listing-team-visibility';

/**
 * Who reads the team on a public listing page.
 *
 * - `isActiveMember` widens the persona side from open, unlinked personas to
 *   every eligible persona, the way `assertPublicViewVisible` widens a persona
 *   read. It also widens the member side from members who turned
 *   `public_profile_enabled` on to every eligible member.
 * - `userId` is set for any signed-in caller and drops each persona or member
 *   who has a block with that caller in either direction, plus each member who
 *   hid their profile from that caller. An anonymous caller carries `null`, so
 *   its query names no viewer parameter and the answer stays the same for every
 *   anonymous caller (the CDN keeps it).
 */
export interface ListingTeamViewer {
  isActiveMember: boolean;
  userId: string | null;
}

/** Exactly one of `subprofile_id` and `user_id` is set (the table's CHECK). */
interface PublicTeamRow {
  subprofile_id: string | null;
  user_id: string | null;
  role_label: string | null;
}

/** The profile columns the member entries need, plus the key to match a row. */
type PublicTeamMemberProfile = ListingTeamMemberColumns & { userId: string };

/**
 * The accepted team of one listing, persona and member entries in one array in
 * the order the business set, at most `LISTING_TEAM_LIMITS.acceptedPerListing`.
 * One query reads the team rows that pass every visibility rule (the limit
 * applies after eligibility, so a hidden entry never takes a slot), one reads
 * the persona columns, one reads the owner names of the linked personas
 * (skipped when none is linked), one reads the member profile columns (skipped
 * when no member is on the team) and one `MediaCropService.getMany` loads the
 * avatar crops. An empty team stops after the first query.
 *
 * The member rules: an anonymous caller, and a signed-in caller who is not an
 * active member, see an eligible member who turned `public_profile_enabled`
 * on. An active member sees every eligible member. A signed-in caller never
 * sees a member who has a block with them in either direction or who hid their
 * profile from them. No user id reaches the result.
 */
export async function loadPublicTeam(
  manager: EntityManager,
  mediaCropService: MediaCropService,
  listingId: string,
  viewer: ListingTeamViewer,
): Promise<ListingTeamMemberPublic[]> {
  const parameters: string[] = [listingId];
  let viewerParameter: string | null = null;
  if (viewer.userId !== null) {
    parameters.push(viewer.userId);
    viewerParameter = `$${parameters.length}`;
  }
  const personaConditions = [
    `"member"."subprofile_id" IS NOT NULL`,
    eligiblePersonaSql('persona'),
  ];
  if (!viewer.isActiveMember) {
    personaConditions.push(anonymousVisiblePersonaSql('persona'));
  }
  if (viewerParameter !== null) {
    personaConditions.push(
      notBlockedEitherWaySql(viewerParameter, '"persona"."user_id"'),
    );
  }
  const memberConditions = [
    `"member"."user_id" IS NOT NULL`,
    viewer.isActiveMember && viewerParameter !== null
      ? eligibleMemberSql('member_profile', 'member_user')
      : anonymousVisibleMemberSql('member_profile', 'member_user'),
  ];
  if (viewerParameter !== null) {
    memberConditions.push(
      notBlockedEitherWaySql(viewerParameter, '"member"."user_id"'),
      notHiddenFromViewerSql(viewerParameter, '"member"."user_id"'),
    );
  }
  const rows = await manager.query<PublicTeamRow[]>(
    `SELECT "member"."subprofile_id", "member"."user_id", "member"."role_label"
       FROM "listing_team_members" "member"
       LEFT JOIN "subprofiles" "persona" ON "persona"."id" = "member"."subprofile_id"
       LEFT JOIN "profiles" "member_profile" ON "member_profile"."user_id" = "member"."user_id"
       LEFT JOIN "users" "member_user" ON "member_user"."id" = "member"."user_id"
      WHERE "member"."listing_id" = $1
        AND "member"."status" = '${ListingTeamMemberStatus.Accepted}'
        AND (
          (${personaConditions.join('\n            AND ')})
          OR
          (${memberConditions.join('\n            AND ')})
        )
      ORDER BY "member"."position" ASC, "member"."id" ASC
      LIMIT ${LISTING_TEAM_LIMITS.acceptedPerListing}`,
    parameters,
  );
  if (rows.length === 0) {
    return [];
  }
  const personaIds = rows.flatMap((row) =>
    row.subprofile_id === null ? [] : [row.subprofile_id],
  );
  const memberUserIds = rows.flatMap((row) =>
    row.user_id === null ? [] : [row.user_id],
  );
  const [personas, memberProfiles] = await Promise.all([
    personaIds.length > 0
      ? manager.find(Subprofile, {
          where: { id: In(personaIds) },
          select: {
            id: true,
            handle: true,
            displayName: true,
            kind: true,
            avatarUrl: true,
            linkVisibility: true,
            userId: true,
          },
        })
      : Promise.resolve([]),
    memberUserIds.length > 0
      ? manager.find(Profile, {
          where: { userId: In(memberUserIds) },
          select: {
            userId: true,
            slug: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            photoVisible: true,
          },
        })
      : Promise.resolve([]),
  ]);
  const linkedOwnerIds = [
    ...new Set(
      personas
        .filter(
          (persona) =>
            persona.linkVisibility === SubprofileLinkVisibility.Linked,
        )
        .map((persona) => persona.userId),
    ),
  ];
  const [crops, ownerProfiles] = await Promise.all([
    mediaCropService.getMany([
      ...personaAvatarKeys(personas),
      ...memberAvatarKeys(memberProfiles),
    ]),
    linkedOwnerIds.length > 0
      ? manager.find(Profile, {
          where: { userId: In(linkedOwnerIds) },
          select: { userId: true, firstName: true, lastName: true },
        })
      : Promise.resolve([]),
  ]);
  const ownerNameByUserId = new Map(
    ownerProfiles.map((profile) => [
      profile.userId,
      ownerNameOf(profile.firstName, profile.lastName),
    ]),
  );
  const personaById = new Map(personas.map((persona) => [persona.id, persona]));
  const memberProfileByUserId = new Map<string, PublicTeamMemberProfile>(
    memberProfiles.map((profile) => [profile.userId, profile]),
  );
  const team: ListingTeamMemberPublic[] = [];
  for (const row of rows) {
    if (row.subprofile_id !== null) {
      const persona = personaById.get(row.subprofile_id);
      if (persona === undefined) {
        continue;
      }
      const shapedPersona = toListingTeamPersona(
        persona,
        crops,
        ownerNameByUserId.get(persona.userId) ?? null,
      );
      if (shapedPersona === null) {
        continue;
      }
      team.push(toListingTeamPersonaPublic(shapedPersona, row.role_label));
      continue;
    }
    const memberProfile =
      row.user_id === null ? undefined : memberProfileByUserId.get(row.user_id);
    if (memberProfile === undefined) {
      continue;
    }
    team.push(
      toListingTeamMemberPublic(
        toListingTeamMemberProfile(memberProfile, crops),
        row.role_label,
      ),
    );
  }
  return team;
}
