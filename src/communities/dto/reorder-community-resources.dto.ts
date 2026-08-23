import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';
import { MAX_RESOURCES_PER_COMMUNITY } from '../community-resources-response';

/**
 * Body for `PATCH /communities/:slug/resources/order` (owner, co-owner or
 * moderator): the shelf's resource ids in the order they should appear.
 *
 * The whole shelf in one call, rather than a per-row `position` on PATCH. A
 * per-row position needs the client to invent a numbering scheme and leaves
 * two rows able to claim the same slot; one ordered list of ids cannot express
 * a tie at all, so the stored order is always exactly what the owner saw when
 * they dragged the row. The service assigns `position` from each id's index.
 */
export class ReorderCommunityResourcesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RESOURCES_PER_COMMUNITY)
  @IsUUID(undefined, { each: true })
  resourceIds!: string[];
}
