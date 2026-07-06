import { PartialType } from '@nestjs/mapped-types';
import { CreateCompanyDto } from './create-company.dto';

// `handle`/`team` are inherited (optional) so a stray value in the payload
// doesn't trip `forbidNonWhitelisted`, but `CompaniesService.update`'s
// `UpdateCompanyInput` type omits both and never reads them — slugs never
// change post-creation and team membership isn't re-seeded on PATCH (mirrors
// `UpdateCommunityDto`'s identical precedent for `handle`/`stewards`/`invites`).
export class UpdateCompanyDto extends PartialType(CreateCompanyDto) {}
