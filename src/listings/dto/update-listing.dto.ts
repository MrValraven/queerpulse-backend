import { PartialType } from '@nestjs/mapped-types';
import { CreateListingDto } from './create-listing.dto';

// `PATCH /listings/:ref` — every draft field is independently patchable
// (mirrors `UpdateCompanyDto`/`UpdatePartnerDto`'s `PartialType` precedent).
// Unlike those, there's no creation-only field to omit here (`name` has no
// slug-deriving side effect on patch — the slug is fixed at creation and
// never re-derived).
export class UpdateListingDto extends PartialType(CreateListingDto) {}
