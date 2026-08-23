import { MemberRef } from '../common/member-ref';
import {
  CommunityResource,
  CommunityResourceKind,
} from './entities/community-resource.entity';

/**
 * How many resources one community's shelf may hold. A shelf is a curated
 * short list a member is meant to be able to read at a glance, so this is a
 * product ceiling as much as a storage one: past a few dozen entries the shelf
 * stops being findable and the community wants a page, not a shelf. 50 leaves
 * generous room above the handful a real community pins (constitution, code of
 * conduct, meeting notes, the group chat, a couple of guides) while keeping
 * every read of this table a single small query with no pagination.
 *
 * Lives here rather than in the service so the reorder DTO can cap its id list
 * at the same number without importing the service.
 */
export const MAX_RESOURCES_PER_COMMUNITY = 50;

/**
 * `GET /communities/:slug/resources` and the single-row responses of the
 * create/update routes. One entry on a community's resource shelf, hand-mapped
 * from `CommunityResource` (there is no global serializer in this repo, so
 * every column that reaches a client is listed here on purpose).
 *
 * `addedBy` is the compact cross-domain `MemberRef` every other community
 * response embeds, and is `null` when the adding owner/mod has erased their
 * account (`created_by_user_id` is `ON DELETE SET NULL`) or has no profile
 * row. `createdByUserId` itself is deliberately NOT exposed: a raw user id is
 * never part of a response in this module.
 */
export interface CommunityResourceDTO {
  id: string;
  title: string;
  url: string;
  note: string | null;
  kind: CommunityResourceKind;
  position: number;
  addedBy: MemberRef | null;
  createdAt: string;
  updatedAt: string;
}

export function toCommunityResourceDTO(
  resource: CommunityResource,
  addedBy: MemberRef | null,
): CommunityResourceDTO {
  return {
    id: resource.id,
    title: resource.title,
    url: resource.url,
    note: resource.note,
    kind: resource.kind,
    position: resource.position,
    addedBy,
    createdAt: resource.createdAt.toISOString(),
    updatedAt: resource.updatedAt.toISOString(),
  };
}

/**
 * The shelf as the About tab reads it: the ordered rows plus the cap, so the
 * editor can disable its "add" affordance at the ceiling instead of
 * discovering it through a 409.
 */
export interface CommunityResourceShelfDTO {
  resources: CommunityResourceDTO[];
  maxResources: number;
}
