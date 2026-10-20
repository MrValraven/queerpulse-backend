import { EntityManager, In } from 'typeorm';
import { MediaCropService } from '../media-crops/media-crops.service';
import {
  Subprofile,
  SubprofileLinkVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { Profile } from '../users/entities/profile.entity';
import { ListingTeamMemberStatus } from './entities/listing-team-member.entity';
import {
  ownerNameOf,
  personaAvatarKeys,
  toListingTeamPersona,
  type ListingTeamMemberPublic,
} from './listing-team-response';
import { LISTING_TEAM_LIMITS } from './listing-team.constants';
import {
  anonymousVisiblePersonaSql,
  eligiblePersonaSql,
  notBlockedEitherWaySql,
} from './listing-team-visibility';

/**
 * Who reads the team on a public listing page.
 *
 * - `isActiveMember` widens the team from open, unlinked personas to every
 *   eligible persona, the way `assertPublicViewVisible` widens a persona read.
 * - `userId` is set for any signed-in caller and drops each persona whose
 *   owner has a block with that caller in either direction. An anonymous
 *   caller carries `null`, so its query names no viewer parameter and the
 *   answer stays the same for every anonymous caller (the CDN keeps it).
 */
export interface ListingTeamViewer {
  isActiveMember: boolean;
  userId: string | null;
}

interface PublicTeamRow {
  subprofile_id: string;
  role_label: string | null;
}

/**
 * The accepted team of one listing, in the order the business set, at most
 * `LISTING_TEAM_LIMITS.acceptedPerListing` members. One query reads the member
 * rows that pass every visibility rule, one reads the persona columns, one
 * reads the owner names of the linked personas (skipped when none is linked)
 * and one `MediaCropService.getMany` loads the avatar crops. An empty team
 * stops after the first query.
 */
export async function loadPublicTeam(
  manager: EntityManager,
  mediaCropService: MediaCropService,
  listingId: string,
  viewer: ListingTeamViewer,
): Promise<ListingTeamMemberPublic[]> {
  const parameters: string[] = [listingId];
  const conditions = [
    `"member"."listing_id" = $1`,
    `"member"."status" = '${ListingTeamMemberStatus.Accepted}'`,
    eligiblePersonaSql('persona'),
  ];
  if (!viewer.isActiveMember) {
    conditions.push(anonymousVisiblePersonaSql('persona'));
  }
  if (viewer.userId !== null) {
    parameters.push(viewer.userId);
    conditions.push(
      notBlockedEitherWaySql(`$${parameters.length}`, '"persona"."user_id"'),
    );
  }
  const rows = await manager.query<PublicTeamRow[]>(
    `SELECT "member"."subprofile_id", "member"."role_label"
       FROM "listing_team_members" "member"
      INNER JOIN "subprofiles" "persona" ON "persona"."id" = "member"."subprofile_id"
      WHERE ${conditions.join('\n        AND ')}
      ORDER BY "member"."position" ASC, "member"."id" ASC
      LIMIT ${LISTING_TEAM_LIMITS.acceptedPerListing}`,
    parameters,
  );
  if (rows.length === 0) {
    return [];
  }
  const personas = await manager.find(Subprofile, {
    where: { id: In(rows.map((row) => row.subprofile_id)) },
    select: {
      id: true,
      handle: true,
      displayName: true,
      kind: true,
      avatarUrl: true,
      linkVisibility: true,
      userId: true,
    },
  });
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
    mediaCropService.getMany(personaAvatarKeys(personas)),
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
  const team: ListingTeamMemberPublic[] = [];
  for (const row of rows) {
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
    team.push({ persona: shapedPersona, roleLabel: row.role_label });
  }
  return team;
}
