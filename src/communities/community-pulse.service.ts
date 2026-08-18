import { Injectable, Logger } from '@nestjs/common';
import { EventsService } from '../events/events.service';
import { ForumThreadsService } from '../forum/forum-threads.service';
import { VolunteeringService } from '../volunteering/volunteering.service';
import { CommunityMembershipService } from './community-membership.service';
import { CommunityPulseResponse } from './community-pulse-response';

const DEFAULT_LANE_LIMIT = 5;

// Postgres SQLSTATEs for "the object this query names doesn't exist yet" —
// `undefined_table` (a whole relation, e.g. a not-yet-run `CREATE TABLE`) and
// `undefined_column` (an existing table missing a not-yet-run `ADD COLUMN`,
// e.g. `volunteer_opportunities.community_id` before
// `AddVolunteerOpportunityCommunityId` has run in a given environment). These
// are schema-not-applied-yet signals, not application bugs — every other
// Postgres error class (syntax errors, real bugs, connection failures, ...)
// must keep propagating so this pulse feature never silently masks one.
const UNDEFINED_TABLE = '42P01';
const UNDEFINED_COLUMN = '42703';

function isSchemaNotReadyError(error: unknown): boolean {
  const candidate = error as {
    code?: string;
    driverError?: { code?: string };
  };
  const code = candidate?.code ?? candidate?.driverError?.code;
  return code === UNDEFINED_TABLE || code === UNDEFINED_COLUMN;
}

/**
 * Backs `GET /communities/:slug/pulse` — the read side of "Personalized
 * Community Pulse", the abandoned initiative that gave `Event`/
 * `ForumThread`/`VolunteerOpportunity` an optional `communityId` (three
 * separate migrations, same comment) but never wired a query to list
 * "things attached to this community" back out. This service is the one
 * generic read side for all three, not three bespoke ones: it fans out to
 * each feature module's own new `listUpcomingByCommunity`/
 * `listRecentByCommunity`/`listOpenByCommunity` method in parallel and
 * combines the results.
 */
@Injectable()
export class CommunityPulseService {
  private readonly logger = new Logger(CommunityPulseService.name);

  constructor(
    private readonly membership: CommunityMembershipService,
    private readonly eventsService: EventsService,
    private readonly forumThreadsService: ForumThreadsService,
    private readonly volunteeringService: VolunteeringService,
  ) {}

  /**
   * Resolves the community by slug and asserts the caller is a roster
   * member (via `CommunityMembershipService.assertMemberBySlug` — 404 for an
   * unknown/archived community, 403 for a resolved-but-non-member caller,
   * same posture every other cross-feature `communitySlug` write already
   * uses), then fans out to the three lanes in parallel — one round trip's
   * worth of parallelism, not three sequential awaits.
   */
  async getPulseBySlug(
    slug: string,
    userId: string,
  ): Promise<CommunityPulseResponse> {
    const communityId = await this.membership.assertMemberBySlug(slug, userId);

    const [upcomingEvents, recentThreads, openOpportunities] =
      await Promise.all([
        this.safeList('upcomingEvents', () =>
          this.eventsService.listUpcomingByCommunity(
            communityId,
            DEFAULT_LANE_LIMIT,
          ),
        ),
        this.safeList('recentThreads', () =>
          this.forumThreadsService.listRecentByCommunity(
            communityId,
            DEFAULT_LANE_LIMIT,
          ),
        ),
        this.safeList('openOpportunities', () =>
          this.volunteeringService.listOpenByCommunity(
            communityId,
            DEFAULT_LANE_LIMIT,
          ),
        ),
      ]);

    return { upcomingEvents, recentThreads, openOpportunities };
  }

  /**
   * Runs one lane's loader, degrading to `[]` (logged, not thrown) when the
   * failure looks like a not-yet-applied migration on that lane's own
   * `communityId` column/table — see `isSchemaNotReadyError`. Any other
   * error (a genuine bug) still propagates and 500s the request rather than
   * being swallowed.
   */
  private async safeList<T>(
    lane: string,
    loader: () => Promise<T[]>,
  ): Promise<T[]> {
    try {
      return await loader();
    } catch (error) {
      if (isSchemaNotReadyError(error)) {
        this.logger.warn(
          `Community pulse lane "${lane}" degraded to [] — schema not ready yet (${String(
            (error as { message?: string })?.message ?? error,
          )})`,
        );
        return [];
      }
      throw error;
    }
  }
}
