import { PartialType } from '@nestjs/mapped-types';
import { CreateOrgTierDto } from './create-org-tier.dto';

// `handle` is inherited (optional) so a stray value doesn't trip
// forbidNonWhitelisted, but slugs never change post-creation and the service's
// update path never reads it (mirrors UpdateCompanyDto).
export class UpdateOrgTierDto extends PartialType(CreateOrgTierDto) {}
