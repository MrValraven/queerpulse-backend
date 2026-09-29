import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { ConnectionStatus } from '../connections/entities/connection.entity';
import type { RsvpDetailsVisibility } from './entities/event-rsvp.entity';

const EVERYONE: RsvpDetailsVisibility = 'everyone';
const CONNECTIONS: RsvpDetailsVisibility = 'connections';

/**
 * PRD-414: the attendee's own answer to "Who can see you're going?"
 * (`event_rsvps.visibility`), applied to a roster query read by somebody who
 * is NOT an organiser of the gathering.
 *
 * A row stays in the result when any one of these holds:
 *  - it is the viewer's own RSVP (a member always sees themselves);
 *  - the attendee chose `everyone`, or never chose (`NULL`, the default for
 *    every RSVP made before the modal was opened);
 *  - the attendee chose `connections` and the viewer is an accepted
 *    connection of theirs, in either request direction.
 * A `justMe` row therefore reaches organisers only, and callers skip this
 * helper entirely for organisers, who always see the whole roster.
 *
 * In-query, like `BlockFilterService.excludeBlocked`, so a page of
 * `PAGE_SIZE` attendees comes back full and a `LIMIT` counts only rows the
 * viewer may see. The connection test uses the same both-directions
 * `requester_id` / `addressee_id` shape as `ConnectionsService`'s own
 * accepted-connection reads, so it walks the two per-column indexes.
 *
 * Splicing contract, same as `excludeBlocked`: `rsvpAlias` is the query
 * builder's alias for the `EventRsvp` row, and the helper binds its own
 * `attendeeVisibility*` parameter names so it can sit beside the block
 * filter on one builder. Call it at most once per query builder.
 */
export function restrictToAttendeesVisibleTo<Entity extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<Entity>,
  viewerId: string,
  rsvpAlias: string,
): SelectQueryBuilder<Entity> {
  const userIdColumn = `"${rsvpAlias}"."user_id"`;
  const visibilityColumn = `"${rsvpAlias}"."visibility"`;
  return queryBuilder.andWhere(
    `(
      ${userIdColumn} = :attendeeVisibilityViewerId
      OR ${visibilityColumn} IS NULL
      OR ${visibilityColumn} = :attendeeVisibilityEveryone
      OR (
        ${visibilityColumn} = :attendeeVisibilityConnections
        AND EXISTS (
          SELECT 1 FROM "connections" "__attendee_connection"
          WHERE "__attendee_connection"."status" = :attendeeVisibilityAccepted
            AND (
              ("__attendee_connection"."requester_id" = :attendeeVisibilityViewerId AND "__attendee_connection"."addressee_id" = ${userIdColumn})
              OR ("__attendee_connection"."addressee_id" = :attendeeVisibilityViewerId AND "__attendee_connection"."requester_id" = ${userIdColumn})
            )
        )
      )
    )`,
    {
      attendeeVisibilityViewerId: viewerId,
      attendeeVisibilityEveryone: EVERYONE,
      attendeeVisibilityConnections: CONNECTIONS,
      attendeeVisibilityAccepted: ConnectionStatus.Accepted,
    },
  );
}
