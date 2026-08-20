import { PartialType } from '@nestjs/mapped-types';
import { CreateResourceListingDto } from './create-resource-listing.dto';

// Every field becomes optional; a PATCH can touch just one. The "at least
// one contact field" invariant is re-checked against the fully merged row in
// `AdminResourceListingsService.update` — see the decorator's doc comment.
export class UpdateResourceListingDto extends PartialType(
  CreateResourceListingDto,
) {}
