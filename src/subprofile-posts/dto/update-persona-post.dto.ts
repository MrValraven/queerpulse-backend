import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { IsSafeUrl } from '../../common/validators/is-safe-url.decorator';
import { PERSONA_POST } from '../persona-post.constants';
import {
  HTTPS_LINK_MESSAGE,
  HTTPS_LINK_PATTERN,
  trimPostText,
} from './create-persona-post.dto';

/** Validate whenever present, so `null` fails the type check. */
const isPresentValue = (_body: object, value: unknown): boolean =>
  value !== undefined;

/** `PATCH /subprofile-posts/:postId`. An absent field stays; `body`
 *  refuses null; `linkUrl` and `imageKey` take null to clear. An omitted
 *  `imageKey` keeps the stored photo. */
export class UpdatePersonaPostDto {
  @ValidateIf(isPresentValue)
  @Transform(trimPostText)
  @IsString()
  @MinLength(1)
  @MaxLength(PERSONA_POST.bodyMax)
  body?: string;

  @IsOptional()
  @IsString()
  @MaxLength(PERSONA_POST.linkMax)
  @IsSafeUrl()
  @Matches(HTTPS_LINK_PATTERN, { message: HTTPS_LINK_MESSAGE })
  linkUrl?: string | null;

  @IsOptional()
  @IsImageReference()
  imageKey?: string | null;
}
