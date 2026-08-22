import { PartialType } from '@nestjs/mapped-types';
import { CreateGroupListingDto } from './create-group-listing.dto';

/**
 * `PATCH /housing-groups/:slug/listings/:id` body — the POSTER correcting their
 * own listing (BE-HSG-20). Every field optional; the bounds and the group norms
 * (a real price, real accessibility information) are inherited from
 * `CreateGroupListingDto`, so a norm cannot be edited away after the fact.
 *
 * Note `PartialType` makes `priceEuros` and `accessibilityInfo` optional to
 * OMIT, never optional to blank: sending them still runs `@Min(1)` /
 * `@MinLength(2)`, and the columns stay NOT NULL either way.
 */
export class UpdateGroupListingDto extends PartialType(CreateGroupListingDto) {}
