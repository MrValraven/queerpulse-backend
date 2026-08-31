import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/** How many join requests one assessment call may cover. Comfortably more than
 *  a queue page, small enough that the `IN (...)` stays sane. */
export const BAN_EVASION_MAX_SUBJECTS = 60;

/**
 * `GET /admin/ban-evasion/join-requests?ids=a,b,c`, and the community-scoped
 * `GET /communities/:slug/join-requests/ban-evasion?ids=a,b,c`.
 *
 * Addressed by join-request ID only, never by a raw email in the query string:
 * a reviewer can assess a request that is in front of them in the queue, and
 * there is no way to use either endpoint to ask "has this arbitrary address
 * ever been banned", which would turn a review aid into a lookup oracle.
 *
 * Shared by both routes on purpose, so the batch size and the id parsing stay
 * one definition. They read DIFFERENT tables: `join_requests` (a stranger
 * applying to the platform) for the staff route, `community_join_requests` (a
 * member applying to one community) for the community one.
 */
/** `?ids=a,b,c` arrives as one string; anything else is left for the validators
 *  below to reject rather than coerced into a shape it never had. */
function splitIdList(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export class AssessJoinRequestsQuery {
  @Transform(({ value }) => splitIdList(value))
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(BAN_EVASION_MAX_SUBJECTS)
  @IsUUID(undefined, { each: true })
  ids!: string[];
}
