import { Raw } from 'typeorm';
import { UserStatus } from '../users/entities/user.entity';

/**
 * PRD-507 and PRD-508. The one spelling of "a roster member who counts", for
 * every member COUNT a community shows (the public card, the staff insights
 * panel): the account is `active` (not paused, suspended or in the deletion
 * grace) and the member is not inside a 24-hour self-hide (`hidden_until`
 * unset or already past, the rule `ProfilesService` applies). The roster
 * query and the community stats in `CommunitiesService` apply the same
 * predicate, so a number on a card always agrees with the roster it opens
 * and a drop of one never points at the person who stepped away.
 *
 * `userIdColumn` is a SQL expression for the member's `user_id` (a quoted
 * column or a TypeORM `Raw` alias). The status is written as the enum
 * constant, which is trusted code, so the fragment binds no parameter and
 * cannot collide with a caller's own parameter names.
 */
export function visibleMemberSql(userIdColumn: string): string {
  return `EXISTS (
    SELECT 1 FROM "users" "visible_user"
    INNER JOIN "profiles" "visible_profile"
      ON "visible_profile"."user_id" = "visible_user"."id"
    WHERE "visible_user"."id" = ${userIdColumn}
      AND "visible_user"."status" = '${UserStatus.Active}'
      AND (
        "visible_profile"."hidden_until" IS NULL
        OR "visible_profile"."hidden_until" <= now()
      )
  )`;
}

/** `visibleMemberSql` as a find-options operator on `CommunityMember.userId`,
 *  for a `count({ where: { communityId, userId: visibleMemberUserId() } })`. */
export function visibleMemberUserId(): ReturnType<typeof Raw> {
  return Raw((userIdAlias) => visibleMemberSql(userIdAlias));
}
