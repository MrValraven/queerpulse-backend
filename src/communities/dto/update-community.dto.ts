import { OmitType, PartialType } from '@nestjs/mapped-types';
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
 */
export class UpdateCommunityDto extends PartialType(
  OmitType(CreateCommunityDto, ['handle', 'stewards', 'invites'] as const),
) {}
