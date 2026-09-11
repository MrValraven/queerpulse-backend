import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateResourceDto } from './create-resource.dto';
import { IsDateString, IsOptional } from 'class-validator';

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
) {
  /** The `updatedAt` the editor loaded. When it no longer matches, someone
   *  else saved the guide in between and the write is refused with a 409. */
  @IsOptional() @IsDateString() expectedUpdatedAt?: string;
}
