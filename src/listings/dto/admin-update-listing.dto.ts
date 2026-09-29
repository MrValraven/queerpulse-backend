import { OmitType, PartialType } from '@nestjs/swagger';
import { AdminCreateListingDto } from './admin-create-listing.dto';

/**
 * `PATCH /admin/listings/:ref`: staff editing a listing the platform holds.
 *
 * The business fields of the admin create body, each optional. Four keys
 * are left out on top of what `AdminCreateListingDto` already drops (the
 * owner's personal answers, `ownerRole`, the affirming acceptance):
 * `publishState` and `ownerOffer`, which have their own routes once a listing
 * exists, `path`, which is fixed at creation, and `rel`, the submitter's
 * relationship to the business. `rel` is one of the seven
 * `OWNER_PERSONAL_LISTING_FIELDS`; the create body keeps it, and this body
 * drops it so staff edit the business and leave the person's answers to
 * whoever holds the listing. The global `forbidNonWhitelisted` pipe answers
 * 400 to any of them.
 *
 * The mapped types come from `@nestjs/swagger`, the package
 * `AdminCreateListingDto` builds on, so the OpenAPI metadata carries through.
 */
export class AdminUpdateListingDto extends PartialType(
  OmitType(AdminCreateListingDto, [
    'publishState',
    'ownerOffer',
    'path',
    'rel',
  ] as const),
) {}
