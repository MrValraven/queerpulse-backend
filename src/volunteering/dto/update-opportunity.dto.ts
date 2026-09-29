import { PartialType } from '@nestjs/mapped-types';
import { CreateOpportunityDto } from './create-opportunity.dto';

// `handle`/`team` are inherited (optional) so a stray value in the payload
// doesn't trip `forbidNonWhitelisted`, but `VolunteeringService.update`'s
// `UpdateOpportunityInput` type omits both and never reads them — slugs never
// change post-creation and team membership isn't re-seeded on PATCH (mirrors
// `UpdateCompanyDto`'s identical "handle/team ignored on patch" precedent).
// `partnerSlug`/`communitySlug` are different: both ARE read on PATCH,
// re-resolving (or clearing) the opportunity's organisation link. Re-sending
// the slug already linked keeps it without re-checking ownership, and setting
// one side clears the other (see `VolunteeringService.update`).
export class UpdateOpportunityDto extends PartialType(CreateOpportunityDto) {}
