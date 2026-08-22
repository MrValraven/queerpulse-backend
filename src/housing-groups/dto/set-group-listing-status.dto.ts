import { IsEnum } from 'class-validator';
import { GroupListingStatus } from '../entities/group-listing.entity';

/**
 * `PATCH /admin/housing-groups/listings/:id/status` body — the housing
 * moderator's pre-publication decision on a group listing (BE-HSG-01).
 *
 * Distinct from `HideGroupListingDto`, which is the POST-publication norm
 * takedown: this one decides whether the listing ever becomes public at all.
 * Mirrors `UpdateHousingListingStatusDto`'s shape on the sibling surface — any
 * of the three states is directly settable, since there is no narrower
 * transition graph in this domain's contract either.
 */
export class SetGroupListingStatusDto {
  @IsEnum(GroupListingStatus)
  status!: GroupListingStatus;
}
