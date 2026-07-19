import { Paginated } from '../common/pagination';
import {
  FullProfileResponse,
  LimitedProfileResponse,
} from '../profiles/profile-response';
import { SavedItemDTO } from '../saved/saved-response';
import { BlockDTO, MuteDTO } from '../social/social-response';

/**
 * The session bootstrap payload — the four slices every signed-in page needs,
 * in one round trip.
 *
 * Each slice is byte-identical to what its standalone endpoint returns, which
 * is the whole point: the frontend seeds these straight into its query caches
 * under the keys those endpoints already populate, so no adapter, DTO or
 * consumer changes. The standalone endpoints stay as the source of truth for
 * refetch and pagination — this is a cache-warmer, not a replacement.
 *
 * Fixed size on purpose: page 1 of each list, never more. "Load more" goes to
 * the paginated endpoints.
 */
export interface BootstrapResponse {
  /** As GET /profiles/:slug, for the caller's own slug. Always `limited: false`
   *  — a member is never limited against themselves. */
  profile: FullProfileResponse | LimitedProfileResponse;
  /** As GET /me/saved, page 1. */
  saved: Paginated<SavedItemDTO>;
  /** As GET /blocks, page 1. */
  blocks: Paginated<BlockDTO>;
  /** As GET /mutes, page 1. */
  mutes: Paginated<MuteDTO>;
}
