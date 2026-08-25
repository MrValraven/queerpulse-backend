import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateListingDto } from './create-listing.dto';

// `PATCH /listings/:ref` — every draft field is independently patchable
// (mirrors `UpdateCompanyDto`/`UpdatePartnerDto`'s `PartialType` precedent).
// `name` has no slug-deriving side effect on patch: the slug is fixed at
// creation and never re-derived.
//
// `affirmingBaselineAccepted` is the one creation field omitted. The affirming
// baseline is the mandatory condition of appearing in the directory at all, so
// there is no edit that un-agrees to it, and leaving it patchable would have
// made a promise every listing has already made look like a setting. Because
// it is omitted rather than ignored, the global `forbidNonWhitelisted`
// ValidationPipe rejects a PATCH that carries it instead of silently accepting
// a change that never happens.
export class UpdateListingDto extends PartialType(
  OmitType(CreateListingDto, ['affirmingBaselineAccepted'] as const),
) {}
