import { EntityManager } from 'typeorm';
import { STUDIO_LANDING_JOIN_SOURCES } from './studio.constants';

/**
 * Files the Studio access request of a member who asked to join from the
 * Studio page (contract 13). One row per member: `wants_to_release` reads
 * true when any join request redeemed by this invite came from the artist
 * call, and `is_from_invite` marks the row as filed for the member. A request
 * the member already filed stays as it is.
 */
export const FILE_STUDIO_ACCESS_REQUEST_SQL = `INSERT INTO "studio_access_requests" ("user_id", "wants_to_release", "is_from_invite")
SELECT $2::uuid, bool_or("join_request"."source" = '${STUDIO_LANDING_JOIN_SOURCES.artist}'), true
  FROM "join_requests" "join_request"
 WHERE "join_request"."invite_id" = $1
   AND "join_request"."source" IN ('${STUDIO_LANDING_JOIN_SOURCES.listener}', '${STUDIO_LANDING_JOIN_SOURCES.artist}')
HAVING count(*) > 0
ON CONFLICT ("user_id") DO NOTHING`;

/**
 * Studio landing v2 (design 7.7): a member who asked to join from the Studio
 * page lands on the Waiting for Studio list the moment their account exists.
 *
 * Called by `AuthService.createInvitedAccount` inside its signup transaction,
 * right after the invite is claimed. Both sign-in paths (Google and email
 * code) pass through that method, and an approval invite keeps its id on
 * reissue, so `join_requests.invite_id` finds the join request that earned
 * it. A personal invite has no join request and files nothing. A plain
 * function over the caller's `EntityManager`, the shape of
 * `forgetDiscoveryTiesOfPersona`, so the auth module imports no Studio
 * provider.
 */
export async function fileStudioAccessRequestForInvite(
  manager: EntityManager,
  inviteId: string,
  userId: string,
): Promise<void> {
  await manager.query(FILE_STUDIO_ACCESS_REQUEST_SQL, [inviteId, userId]);
}
