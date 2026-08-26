import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { GroupListingStatus } from '../entities/group-listing.entity';

/**
 * `PATCH /admin/housing-groups/listings/:id/status` body — the housing
 * moderator's pre-publication decision on a group listing (BE-HSG-01).
 *
 * Distinct from `HideGroupListingDto`, which is the POST-publication norm
 * takedown: this one decides whether the listing ever becomes public at all.
 * Mirrors `UpdateHousingListingStatusDto`'s shape on the sibling surface — any
 * of the states is directly settable, since there is no narrower transition
 * graph in this domain's contract either.
 *
 * `reason` is the LOC-19 addition and it is the whole point of the change: the
 * decision is now sent to the poster, so a refusal without a sentence attached
 * would be a notification that says only "no" about a room somebody actually
 * wrote up. The service REQUIRES it for `declined` and for `question` (a
 * question with no question in it is not one) and leaves it optional for
 * `live` and `review`. Whitespace-only text is normalised to null there and
 * then refused where it was required.
 */
export class SetGroupListingStatusDto {
  @IsEnum(GroupListingStatus)
  status!: GroupListingStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
