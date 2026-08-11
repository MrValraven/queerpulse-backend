import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsString,
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
}
