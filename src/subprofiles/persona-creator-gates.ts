import { Raw } from 'typeorm';
import { UserStatus } from '../users/entities/user.entity';
import {
  Subprofile,
  SubprofileLinkVisibility,
} from './entities/subprofile.entity';

/**
 * SEC-02: whether a person block between a viewer and a persona's creator
 * may withhold that persona from the viewer.
 *
 * Only a LINKED persona names its creator, so only there does a block of the
 * creator tell the viewer something the page already shows. An UNLINKED
 * persona answers every viewer the same, whoever they blocked or were
 * blocked by. Withholding it on a block of its creator turned blocking into
 * an ownership test: block a suspect, watch which pseudonymous persona
 * disappears, unblock. Every read, follow, endorse and contact path asks
 * this one question so the answer cannot drift between them.
 */
export function isCreatorBlockConsulted(
  persona: Pick<Subprofile, 'linkVisibility'>,
): boolean {
  return persona.linkVisibility === SubprofileLinkVisibility.Linked;
}

/**
 * The `actorId` a notification about this persona is block- and mute-filtered
 * against: the creator of a LINKED persona, and none for an unlinked one. A
 * follower who blocked or muted a suspect and stopped hearing from an
 * unlinked persona would learn who runs it. The payload names the persona,
 * so the bell reads the same with no actor.
 */
export function personaNotificationActorId(
  persona: Pick<Subprofile, 'linkVisibility' | 'userId'>,
): string | undefined {
  return isCreatorBlockConsulted(persona) ? persona.userId : undefined;
}

/**
 * The SQL twin of `isCreatorBlockConsulted` for a persona query builder: true
 * for an unlinked persona. Passed as the `unless` of
 * `BlockFilterService.excludeBlocked`, so the block filter keyed on the
 * creator's id applies to linked rows alone.
 */
export function unlinkedPersonaSql(personaAlias = 'sp'): string {
  return `"${personaAlias}"."link_visibility" = '${SubprofileLinkVisibility.Unlinked}'`;
}

/**
 * `unlinkedPersonaSql` for a persona named only by its id (a raw SQL
 * expression such as `"playlist"."credit_subprofile_id"`): true when that
 * persona is unlinked. A NULL id or a missing persona reads false.
 */
export function unlinkedPersonaByIdSql(personaIdExpression: string): string {
  return `EXISTS (
    SELECT 1 FROM "subprofiles" "unlinked_persona"
    WHERE "unlinked_persona"."id" = ${personaIdExpression}
      AND "unlinked_persona"."link_visibility" = '${SubprofileLinkVisibility.Unlinked}'
  )`;
}

/**
 * SEC-33: a persona shows publicly only while its creator's account is
 * active. A suspended, banned, paused or erasure-pending member's personas
 * leave every public read, signed-out visitors included, as their profile
 * does.
 *
 * Co-owned personas follow the creator too. The creator is the member a
 * linked persona names and addresses, and a co-owner keeps reading and
 * managing the persona through the owner-facing reads, which skip this gate.
 * When a creator leaves a persona or erases their account, the creator role
 * passes to a co-owner, so the persona comes back under them.
 */
export function personaCreatorActiveSql(personaAlias = 'sp'): string {
  return `EXISTS (
    SELECT 1 FROM "users" "persona_creator"
    WHERE "persona_creator"."id" = "${personaAlias}"."user_id"
      AND "persona_creator"."status" = '${UserStatus.Active}'
  )`;
}

/** The find-options twin of `personaCreatorActiveSql`, for a `where` on the
 *  `subprofiles` repository. */
export const PERSONA_CREATOR_ACTIVE_WHERE = {
  user: { status: UserStatus.Active },
} as const;

/**
 * SEC-21: a member named on a persona's people list (followers, endorsers)
 * only while their account is active and they have no live "Hide me for 24
 * hours". `memberIdColumn` is an already quoted `"alias"."column"`. Both are
 * `EXISTS` predicates, so no join reaches a `skip`/`take` page or its count.
 */
export function memberShownOnPeopleListSql(memberIdColumn: string): string {
  return `(EXISTS (
      SELECT 1 FROM "users" "people_list_user"
      WHERE "people_list_user"."id" = ${memberIdColumn}
        AND "people_list_user"."status" = '${UserStatus.Active}'
    ) AND NOT EXISTS (
      SELECT 1 FROM "profiles" "people_list_profile"
      WHERE "people_list_profile"."user_id" = ${memberIdColumn}
        AND "people_list_profile"."hidden_until" > now()
    ))`;
}

/** The numbered suffix `memberIdShownOnPeopleListIn` gives its parameter. */
let peopleListParameterSequence = 0;

/**
 * `memberShownOnPeopleListSql` as a find-options operator on a member's
 * `userId`: matches the ids in `memberIds` whose account is active and who
 * have no live "Hide me for 24 hours". For a credit that names a member by
 * name, photo and slug, which hides that member the way the people lists do.
 * The column alias is parenthesised before it is spliced, so TypeORM
 * rewrites every occurrence of it into a quoted column. Each call binds its
 * ids under its own numbered parameter name, so two of them in one `find`
 * keep their own ids.
 */
export function memberIdShownOnPeopleListIn(
  memberIds: readonly string[],
): ReturnType<typeof Raw> {
  peopleListParameterSequence += 1;
  const parameterName = `shownPeopleListMemberIds${peopleListParameterSequence}`;
  return Raw(
    (memberIdColumn) =>
      `(${memberIdColumn} IN (:...${parameterName}) AND ${memberShownOnPeopleListSql(`(${memberIdColumn})`)})`,
    { [parameterName]: [...memberIds] },
  );
}
