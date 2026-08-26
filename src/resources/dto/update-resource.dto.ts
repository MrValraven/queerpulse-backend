import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateResourceDto } from './create-resource.dto';

/**
 * Every field optional, `slug` included via `PartialType` — a guide's slug is
 * its public address, and an editor who genuinely needs to rename one should
 * be able to, so the service checks for a collision rather than the DTO
 * forbidding it outright.
 *
 * `publishedAt` is dropped here and handled by the dedicated publish/unpublish
 * endpoints instead: taking a crisis guide off the site should be a named
 * action in the audit trail, not a field on a general-purpose PATCH.
 */
export class UpdateResourceDto extends PartialType(
  OmitType(CreateResourceDto, ['publishedAt'] as const),
) {}
