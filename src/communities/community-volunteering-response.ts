import { OpportunityCardDTO } from '../volunteering/opportunity-response';

/**
 * `GET /communities/:slug/volunteering`: the community page's Volunteering
 * tab. Every open opportunity attributed to this community (status open,
 * spots left, under no takedown), newest first, in the same
 * `OpportunityCardDTO` shape the main board and the pulse lane already use.
 *
 * `items` is capped at `COMMUNITY_OPPORTUNITIES_LIMIT`; `total` counts every
 * open opportunity, so the tab can badge the full number and say when it is
 * showing only the newest ones. A space always answers an empty page.
 */
export interface CommunityOpportunitiesResponse {
  items: OpportunityCardDTO[];
  total: number;
}
