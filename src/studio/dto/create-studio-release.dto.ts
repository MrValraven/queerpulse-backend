import { Transform } from 'class-transformer';
import { IsIn, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { StudioReleaseType } from '../entities/studio-release.entity';
import { STUDIO_LIMITS, STUDIO_RELEASE_TYPES } from '../studio.constants';

/** `@Transform` helper shared by the Studio bodies: trims a string value. */
export const trimStringValue = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** `@ValidateIf` helper for PATCH fields that refuse null: validate whenever
 *  the field is present, so `null` fails the type check. */
export const isPresentValue = (_body: object, value: unknown): boolean =>
  value !== undefined;

export class CreateStudioReleaseDto {
  @IsUUID()
  subprofileId!: string;

  @IsIn(STUDIO_RELEASE_TYPES)
  type!: StudioReleaseType;

  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.releaseTitleMaxLength)
  title!: string;
}
