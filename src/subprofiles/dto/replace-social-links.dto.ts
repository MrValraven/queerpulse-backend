import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IsSafeUrl } from '../../common/validators/is-safe-url.decorator';
import { KNOWN_PLATFORM_KEYS } from '../subprofile-validation';

class SocialLinkInputDTO {
  // Field-level `@IsIn` against the shared known-platform list, so an unknown
  // platform is a 400 on this field rather than a generic service throw.
  @IsString()
  @MaxLength(40)
  @IsIn(KNOWN_PLATFORM_KEYS)
  platform!: string;

  // A social value is a full URL, a `mailto:` (the `email` platform), or a bare
  // `@handle`/host the frontend renders behind an `https://` prefix — so the
  // handle-accepting variant. Still rejects `javascript:`/`data:`/`vbscript:`
  // and any other executable scheme.
  @IsString()
  @MaxLength(300)
  @IsSafeUrl({ allowHandle: true })
  urlOrHandle!: string;
}

export class ReplaceSocialLinksDTO {
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SocialLinkInputDTO)
  items!: SocialLinkInputDTO[];

  // ENG-451 save precondition. When it differs from the stored `edit_version`
  // the PUT answers 409 `PERSONA_EDIT_CONFLICT` and changes nothing.
  @ApiPropertyOptional({
    type: Number,
    minimum: 0,
    description:
      'The editVersion this save was built on. A stored editVersion that differs answers 409 { code: "PERSONA_EDIT_CONFLICT", currentEditVersion }. When omitted the save is unconditional.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedEditVersion?: number;
}
