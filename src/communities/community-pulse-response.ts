import { CommunityUpcomingEventSummary } from '../events/event-response';
import { ForumThreadResponse } from '../forum/forum-response';
import { OpportunityCardDTO } from '../volunteering/opportunity-response';

/**
 * `GET /communities/:slug/pulse` — "Personalized Community Pulse" (the phrase
 * shared by the three migrations that each gave `Event`/`ForumThread`/
 * `VolunteerOpportunity` an optional `communityId`, but never wired a read
 * side back to the community that owns them — see `CommunityPulseService`).
 * Every lane reuses its feature module's own existing card/summary shape
 * rather than inventing a new one: `EventSummary` (`events/event-response`),
 * `ForumThreadResponse` (`forum/forum-response`), `OpportunityCardDTO`
 * (`volunteering/opportunity-response`). Each gathering row also says
 * whether this community leads it or joined it as an accepted guest
 * (`hostedAs`, `leadCommunity`).
 */
export interface CommunityPulseResponse {
  upcomingEvents: CommunityUpcomingEventSummary[];
  recentThreads: ForumThreadResponse[];
  openOpportunities: OpportunityCardDTO[];
}
