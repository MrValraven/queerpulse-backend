import { OmitType, PartialType } from '@nestjs/mapped-types';
import { Equals, IsOptional } from 'class-validator';
import { CreateCommunityDto } from './create-community.dto';

/**
 * `PATCH /communities/:slug` body.
 *
 * A partial of the create DTO MINUS the three creation-only fields.
 * `handle`, `stewards` and `invites` used to be inherited (optional) so a
 * stray value wouldn't trip `forbidNonWhitelisted` — but the service reads
 * none of them, so the whitelist pipe silently accepted and dropped them and
 * a client bug ("rename the handle") looked like a success (BE-COM-22). They
 * are omitted here instead, so sending one is now a 400 that names the field.
 *
 * Slugs never change post-creation (spec: "handle ignored on patch"), and
 * `stewards`/`invites` are creation-time invitations with no patch-time
 * re-send semantics — a later invitation goes through the community's own
 * invite/role routes.
 *
 * `setupChecklistDismissed` is staff state: it stamps the setup checklist
 * dismissed and `CommunitiesService.update` handles it outside the settings
 * diff.
 */
export class UpdateCommunityDto extends PartialType(
  OmitType(CreateCommunityDto, ['handle', 'stewards', 'invites'] as const),
) {
  // Staff only. Stamps the community's setup checklist dismissed once; handled
  // outside the settings diff by `CommunitiesService.update`.
  @IsOptional()
  @Equals(true)
  setupChecklistDismissed?: true;
}
